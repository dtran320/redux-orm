import forOwn from 'lodash/object/forOwn';

import {ManyToMany, ForeignKey} from './fields';
import Session from './Session';
import Meta from './Meta';
import Manager from './Manager';
import {CREATE, UPDATE, DELETE, ORDER} from './constants';
import {m2mName, m2mToFieldName, m2mFromFieldName} from './utils';

/**
 * The heart of an ORM, the data model.
 * The static class methods manages the mutations
 * passed to this. The class itself is connected to a session,
 * and because of this you can only have a single session at a time
 * for a {@link Model} class.
 *
 * An instance of {@link Model} represents an object in the database.
 *
 * To create data models in your schema, subclass {@link Model}. To define
 * information about the data model, override static class methods. Define instance
 * logic by defining prototype methods (without `static` keyword).
 */
const Model = class Model {
    /**
     * Creates a Model instance.
     * @param  {Object} props - the properties to instantiate with
     */
    constructor(props) {
        const ModelClass = this.getClass();
        this._initFields(ModelClass.fields, props);
        this._initVirtualFields(ModelClass.virtualFields);
    }

    _initVirtualFields(virtualFields) {
        const ModelClass = this.getClass();
        const session = ModelClass.session;

        forOwn(virtualFields, (fieldInstance, fieldName) => {
            Object.defineProperty(this, fieldName, {
                get: fieldInstance.getGetter(session, this, fieldName),
                set: fieldInstance.getSetter(session, this, fieldName),
            });
        });
    }

    _initFields(fields, props) {
        this._fieldNames = [];
        this._fields = props;
        const ModelClass = this.getClass();
        const modelName = ModelClass.getName();
        const idAttribute = ModelClass.getMetaInstance().idAttribute;
        const session = ModelClass.session;

        const fieldsAssigned = [];

        forOwn(fields, (fieldInstance, fieldName) => {
            // console.log('initing related fields: ', fieldName, props[fieldName]);
            Object.defineProperty(this, fieldName, {
                get: fieldInstance.getGetter(session, this, fieldName, props[fieldName]),
                set: fieldInstance.getSetter(session, this, fieldName),
            });
            fieldsAssigned.push(fieldName);
        });

        forOwn(props, (fieldValue, fieldName) => {
            this._fieldNames.push(fieldName);
            if (!fieldsAssigned.includes(fieldName)) {
                Object.defineProperty(this, fieldName, {
                    get: () => fieldValue,
                    set: (value) => {
                        session.addMutation({
                            type: UPDATE,
                            payload: {
                                [idAttribute]: this.getId(),
                                [fieldName]: value,
                            },
                            meta: {
                                name: modelName,
                            },
                        });
                    },
                });
            }
        });
    }

    /**
     * Returns the raw state for this {@link Model} in the current {@link Session}.
     * @return {Object} The state for this {@link Model} in the current {@link Session}.
     */
    static get state() {
        return this.session.getState(this.getName());
    }

    static toString() {
        return `ModelClass: ${this.getName()}`;
    }

    /**
     * Returns the {@link Model} class used to instantiate a possible Through model.
     * @return {Model} The Through model class used to handle many-to-many relations declared
     *                 in this model.
     */
    static getThroughModelClass() {
        return Model;
    }

    static getManyToManyModels() {
        const fields = this.fields;
        const thisModelName = this.getName();

        const models = [];
        forOwn(fields, (fieldInstance, fieldName) => {
            if (fieldInstance instanceof ManyToMany) {
                let relatedModelName;
                if (fieldInstance.relatedModelName === 'this') {
                    relatedModelName = thisModelName;
                } else {
                    relatedModelName = fieldInstance.relatedModelName;
                }

                const fromFieldName = m2mFromFieldName(thisModelName);
                const toFieldName = m2mToFieldName(relatedModelName);

                const Through = class ThroughModel extends this.getThroughModelClass() {
                    static get fields() {
                        return {
                            [fromFieldName]: new ForeignKey(thisModelName),
                            [toFieldName]: new ForeignKey(relatedModelName),
                        };
                    }

                    static getMetaOptions() {
                        return {
                            'name': m2mName(thisModelName, fieldName),
                        };
                    }
                };

                models.push(Through);
            }
        });

        return models;
    }

    /**
     * Returns the options object passed to the {@link Meta} class constructor.
     * You need to define this for every subclass.
     *
     * @return {Object} the options object used to instantiate a {@link Meta} class.
     */
    static getMetaOptions() {
        throw new Error('You must declare a static getMetaOptions function in your Model class.');
    }

    /**
     * Returns the {@link Meta} class used to instantiate
     * the {@link Meta} instance for this {@link Model}.
     *
     * Override this if you want to use a custom {@link Meta} class.
     * @return {Meta} The {@link Meta} class or subclass to use for this {@link Model}.
     */
    static getMetaClass() {
        return Meta;
    }

    /**
     * Gets the {@link Meta} instance linked to this {@link Model}.
     * @return {Meta} The {@link Meta} instance linked to this {@link Model}.
     */
    static getMetaInstance() {
        if (!this._meta) {
            const MetaClass = this.getMetaClass();
            this._meta = new MetaClass(this.getMetaOptions());
        }
        return this._meta;
    }

    /**
     * Gets the Model's next state by applying the recorded
     * mutations.
     * @return {Object} The next state.
     */
    static getNextState() {
        if (typeof this.state === 'undefined') {
            return this.getDefaultState();
        }

        const meta = this.getMetaInstance();

        const mutations = this.session.getMutationsFor(this);

        return mutations.reduce((state, action) => {
            switch (action.type) {
            case CREATE:
                return meta.insert(state, action.payload);
            case UPDATE:
                return meta.update(state, action.payload.idArr, action.payload.updater);
            case DELETE:
                return meta.delete(state, action.payload);
            default:
                return state;
            }
        }, this.state);
    }

    /**
     * The default reducer implementation.
     * If the user doesn't define a reducer, this is used.
     *
     * @param {Object} state - the current state
     * @param {Object} action - the dispatched action
     * @param {Model} model - the concrete model class being used
     * @param {Session} session - the current {@link Session} instance
     */
    static reducer(state, action, model, session) {
        return model.getNextState();
    }

    static callUserReducer() {
        return this.reducer(this.state, this.session.action, this, this.session);
    }

    /**
     * Gets the default, empty state of the branch.
     * Delegates to a {@link Meta} instance.
     * @return {Object} The default state.
     */
    static getDefaultState() {
        return this.getMetaInstance().getDefaultState();
    }

    /**
     * Returns the default manager for this model class.
     * @return {Manager} The {@link Manager} for this Model
     */
    static get objects() {
        return new Manager(this);
    }

    /**
     * Gets the name of this {@link Model} class.
     * Delegates to {@link Meta}.
     *
     * Constructors have a name property which we cannot
     * override, so this is implemented as a method.
     *
     * @return {string} The name of this {@link Model} class.
     */
    static getName() {
        return this.getMetaInstance().name;
    }

    /**
     * Returns the id attribute of this {@link Model}.
     * Delegates to the related {@link Meta} instance.
     *
     * @return {string} The id attribute of this {@link Model}.
     */
    static get idAttribute() {
        return this.getMetaInstance().idAttribute;
    }

    /**
     * A convenience method to call {@link Meta#accessId} from
     * the {@link Model} class.
     *
     * @param  {Number} id - the object id to access
     * @return {Object} a reference to the object in the database.
     */
    static accessId(id) {
        return this.getMetaInstance().accessId(this.state, id);
    }

    /**
     * A convenience method to call {@link Meta#accessIdList} from
     * the {@link Model} class with the current state.
     */
    static accessIds() {
        return this.getMetaInstance().accessIdList(this.state);
    }

    static accessList() {
        return this.getMetaInstance().accessList(this.state);
    }

    static iterator() {
        return this.getMetaInstance().iterator(this.state);
    }

    /**
     * Returns the related {@link Manager} instance for this {@link Model}.
     *
     * @return {Manager} The related {@link Manager} instance for this {@link Model}.
     */
    static getRelatedManager() {
        return new Manager(this);
    }

    /**
     * Connect the model class to a {@link Session}.
     *
     * @param  {Session} session - The session to connect to.
     */
    static connect(session) {
        if (!session instanceof Session) {
            throw Error('A model can only connect to a Session instance.');
        }

        this._session = session;
    }

    /**
     * Get the current {@link Session} instance.
     *
     * @return {Session} The current {@link Session} instance.
     */
    static get session() {
        return this._session;
    }

    /**
     * A convenience method that delegates to the current {@link Session} instane.
     * Adds the required metadata about this {@link Model} to the mutation object.
     * @param {Object} mutation - the mutation to add.
     */
    static addMutation(mutation) {
        mutation.meta = {name: this.getName()};
        this.session.addMutation(mutation);
    }

    /**
     * Gets the {@link Model} class or subclass constructor (the class that
     * instantiated this instance).
     *
     * @return {Model} The {@link Model} class or subclass constructor used to instantiate
     *                 this instance.
     */
    getClass() {
        return this.constructor;
    }

    /**
     * Gets the id value of the current instance.
     * @return {*} The id value of the current instance.
     */
    getId() {
        return this._fields[this.getClass().getMetaInstance().idAttribute];
    }

    /**
     * Returns a string representation of the {@link Model} instance.
     * @return {string} A string representation of this {@link Model} instance.
     */
    toString() {
        const className = this.getClass().getName();
        const fields = this._fieldNames.map(fieldName => {
            const val = this._fields[fieldName];
            return `${fieldName}: ${val}`;
        }).join(', ');
        return `${className}: {${fields}}`;
    }

    equals(otherModel) {
        return this.getClass() === otherModel.getClass() && this.getId() === otherModel.getId();
    }

    /**
     * Returns a plain JavaScript object representation
     * of the entity, with the id value set on the `idAttribute` key.
     * `idAttribute` is looked up on the `Manager` class that controls
     * this entity.
     * @return {Object} a plain JavaScript object representing the {@link Model}
     */
    toPlain() {
        const obj = {};
        this._fieldNames.forEach((fieldName) => {
            obj[fieldName] = this._fields[fieldName];
        });
        return obj;
    }

    /**
     * Records a mutation to the {@link Model} instance for a single
     * field value assignment.
     * @param {string} propertyName - name of the property to set
     * @param {*} value - value assigned to the property
     * @return {undefined}
     */
    set(propertyName, value) {
        this.update({[propertyName]: value});
    }

    /**
     * Records a mutation to the {@link Model} instance for multiple field value assignments.
     * @param  {Object} mergeObj - an object that will be merged with this instance.
     * @return {undefined}
     */
    update(mergeObj) {
        this.getClass().addMutation({
            type: UPDATE,
            payload: {
                idArr: [this.getId()],
                updater: mergeObj,
            },
            meta: {
                name: this.getClass().getName(),
            },
        });
    }

    /**
     * Records the {@link Model} to be deleted.
     * @return {undefined}
     */
    delete() {
        this.session.addMutation({
            type: DELETE,
            payload: [this.getId()],
            meta: {
                name: this.getClass().getName(),
            },
        });
    }
};

Model.fields = {};

export default Model;
