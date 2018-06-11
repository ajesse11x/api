'use strict'

const _ = require('underscore-contrib')
const async = require('async')
const debug = require('debug')('api:model')
const path = require('path')

const Composer = require(path.join(__dirname, '/composer')).Composer
const config = require(path.join(__dirname, '/../../../config'))
const Connection = require(path.join(__dirname, '/connection'))
const formatError = require('@dadi/format-error')
const History = require(path.join(__dirname, '/history'))
const Hook = require(path.join(__dirname, '/hook'))
const logger = require('@dadi/logger')
const Search = require(path.join(__dirname, '/../search'))
const queryUtils = require(path.join(__dirname, '/utils'))
const Validator = require(path.join(__dirname, '/validator'))

// track all models that have been instantiated by this process
let _models = {}

/**
 * Creates a new Model instance
 * @constructor
 * @classdesc
 */
const Model = function (name, schema, conn, settings) {
  // attach collection name
  this.name = name

  // attach original schema
  if (_models[name] && _.isEmpty(schema)) {
    this.schema = _models[name].schema
  } else {
    this.schema = schema
  }

  // attach default settings
  this.settings = Object.assign({}, settings, this.schema.settings)

  // attach display name if supplied
  if (this.settings.hasOwnProperty('displayName')) {
    this.displayName = this.settings.displayName
  }

  // composable reference fields?
  if (this.settings.hasOwnProperty('compose')) {
    this.compose = this.settings.compose
  }

  // add any configured indexes
  if (this.settings.hasOwnProperty('index')) {
    if (!Array.isArray(this.settings.index)) {
      var indexArray = []

      indexArray.push({
        keys: this.settings.index.keys,
        options: this.settings.index.options || {}
      })

      this.settings.index = indexArray
    }
  }

  // create connection for this model
  if (conn) {
    this.connection = conn
  } else {
    this.connection = Connection(
      {
        database: settings.database,
        collection: this.name
      },
      this.name,
      config.get('datastore')
    )
  }

  this.connection.setMaxListeners(35)

  if (config.get('env') !== 'test') {
    this.connection.once('disconnect', (err) => {
      logger.error({module: 'model'}, err)
    })
  }

  _models[name] = this

  // setup validation context
  this.validate = new Validator(this)

  this.composer = new Composer(this)

  // setup history context unless requested not to
  this.storeRevisions = (this.settings.storeRevisions !== false)

  if (this.storeRevisions) {
    this.history = new History(this)
    // attach revision collection for this model.
    // if no value is specified, use 'History' suffix by default
    this.revisionCollection = (this.settings.revisionCollection ? this.settings.revisionCollection : this.name + 'History')
  }

  // setup search context
  this.searchHandler = new Search(this)

  if (this.searchHandler.canUse()) {
    this.searchHandler.init()
  }

  if (this.settings.index) {
    this.createIndex(() => {})
  }

  if (this.settings.index) {
    this.createIndex(() => {})
  }
}

/**
 * Lookup documents in the database, then give back a count
 *
 * @param {Object} query
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.count = function (query, options, done) {
  if (typeof options === 'function') {
    done = options
    options = {}
  }

  var validation = this.validate.query(query)

  if (!validation.success) {
    var err = createValidationError('Bad Query')
    err.json = validation
    return done(err)
  }

  if (_.isObject(query)) {
    this.find(query, options, (err, results) => {
      if (err) return done(err)
      return done(null, { metadata: results.metadata })
    })
  } else {
    return done(createValidationError('Bad Query'))
  }
}

/**
 * Create a document in the database
 *
 * @param {object} documents - a document, or Array of documents to insert in the database
 * @param {object} internals
 * @param {function} done
 * @return undefined
 * @api public
 */
Model.prototype.create = function (documents, internals, done, req) {
  debug('create %o %o', documents, internals)

  if (!Array.isArray(documents)) {
    documents = [documents]
  }

  // internals will not be validated, i.e. should not be user input
  if (typeof internals === 'function') {
    done = internals
  }

  if (!this.connection.db) {
    return done(createConnectionError())
  }

  // validate each doc
  var validation

  documents.forEach(doc => {
    if (validation === undefined || validation.success) {
      validation = this.validate.schema(doc)
    }
  })

  if (!validation.success) {
    var err = createValidationError('Validation Failed')
    err.success = validation.success
    err.errors = validation.errors
    err.data = documents
    return done(err)
  }

  if (typeof internals === 'object' && internals != null) { // not null and not undefined
    documents.forEach(doc => {
      Object.assign(doc, internals)
    })
  }

  //
  if (this.history) {
    documents.forEach(doc => {
      doc._history = []
    })
  }

  // add initial document revision number
  documents.forEach(doc => {
    doc._version = 1
  })

  // DateTime
  documents.forEach(doc => {
    doc = queryUtils.convertDateTimeForSave(this.schema, doc)
  })

  var startInsert = (database) => {
    // Running `beforeCreate` hooks
    if (this.settings.hooks && this.settings.hooks.beforeCreate) {
      var processedDocs = 0

      documents.forEach((doc, docIndex) => {
        async.reduce(this.settings.hooks.beforeCreate, doc, (current, hookConfig, callback) => {
          var hook = new Hook(hookConfig, 'beforeCreate')

          Promise.resolve(hook.apply(current, this.schema, this.name, req)).then((newDoc) => {
            callback((newDoc === null) ? {} : null, newDoc)
          }).catch(err => {
            callback(hook.formatError(err))
          })
        }, (err, result) => {
          processedDocs++

          if (processedDocs === documents.length) {
            if (err) {
              var errorResponse = {
                success: false,
                errors: err
              }

              return done(errorResponse)
            } else {
              return saveDocuments(database)
            }
          }
        })
      })
    } else {
      return saveDocuments(database)
    }
  }

  var saveDocuments = (database) => {
    database.insert({
      data: documents,
      collection: this.name,
      schema: this.schema,
      settings: this.settings
    }).then(results => {
      let returnData = {
        results: results
      }

      this.composer.compose(returnData.results, (obj) => {
        returnData.results = obj

        // Asynchronous search index
        this.searchHandler.index(returnData.results)

        // apply any existing `afterCreate` hooks
        if (this.settings.hasOwnProperty('hooks') && (typeof this.settings.hooks.afterCreate === 'object')) {
          returnData.results.forEach((doc) => {
            this.settings.hooks.afterCreate.forEach((hookConfig, index) => {
              var hook = new Hook(this.settings.hooks.afterCreate[index], 'afterCreate')

              return hook.apply(doc, this.schema, this.name)
            })
          })
        }

        // Prepare result set for output
        returnData.results = this.formatResultSetForOutput(returnData.results)

        return done(null, returnData)
      })
    }).catch(err => {
      if (err.message === 'DB_DISCONNECTED') {
        return done(createConnectionError())
      }

      return done(err)
    })
  }

  // Pre-composed References
  this.composer.setApiVersion(internals._apiVersion)

  // before the primary document insert, process any Reference fields
  // that have been passed as subdocuments rather than id strings
  documents.forEach((doc, idx) => {
    this.composer.createFromComposed(doc, req, (err, result) => {
      if (err) {
        return done(err.json)
      }

      doc = result

      if (idx === documents.length - 1) {
        return startInsert(this.connection.db)
      }
    })
  })
}

/**
 *
 */
Model.prototype.createIndex = function (done) {
  const createIndexInDatastore = (database) => {
    database.index(this.name, this.settings.index).then(done)
  }

  if (this.connection.db) {
    return createIndexInDatastore(this.connection.db)
  } else {
    this.connection.once('connect', createIndexInDatastore)
  }
}

/**
 * Delete a document from the database
 *
 * @param {Object} query
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.delete = function (query, done, req) {
  var validation = this.validate.query(query)

  if (!validation.success) {
    var err = createValidationError('Bad Query')
    err.json = validation
    return done(err)
  }

  if (!this.connection.db) {
    return done(createConnectionError())
  }

  query = this.formatQuery(query)

  // Is this a RESTful query by ID?
  const isRestIDQuery = req && req.params.id

  var deletedDocs = []
  var allDocs = []

  var deleteDocuments = (database) => {
    database.delete({
      query: query,
      collection: this.name,
      schema: this.schema
    }).then(result => {
      if (result.deletedCount > 0) {
        // clear documents from search index
        this.searchHandler.delete(deletedDocs)

        // apply any existing `afterDelete` hooks
        if (this.settings.hasOwnProperty('hooks') && (typeof this.settings.hooks.afterDelete === 'object')) {
          this.settings.hooks.afterDelete.forEach((hookConfig, index) => {
            var hook = new Hook(this.settings.hooks.afterDelete[index], 'afterDelete')

            return hook.apply(query, deletedDocs, this.schema, this.name)
          })
        }
      }

      result.totalCount = allDocs.metadata.totalCount - result.deletedCount

      return done(null, result)
    }).catch((err) => {
      return done(err)
    })
  }

  this.find({}, { compose: false }, (err, docs) => {
    if (err) return done(err)

    allDocs = docs

    this.find(query, { compose: false }, (err, docs) => {
      if (err) return done(err)

      deletedDocs = docs.results

      if (isRestIDQuery && (deletedDocs.length === 0)) {
        const err = new Error('Document not found')

        err.statusCode = 404

        return done(err)
      }

      var wait = Promise.resolve()

      if (this.history) {
        wait = new Promise((resolve, reject) => {
          // for each of the about-to-be-deleted documents, create a revision for it
          if (deletedDocs.length > 0) {
            this.history.createEach(deletedDocs, 'delete', this).then(() => {
              return resolve()
            }).catch((err) => {
              return reject(err)
            })
          } else {
            return resolve()
          }
        })
      }

      wait.then(() => {
        // apply any existing `beforeDelete` hooks, otherwise delete the documents straight away
        if (this.settings.hooks && this.settings.hooks.beforeDelete) {
          async.reduce(this.settings.hooks.beforeDelete, query, (current, hookConfig, callback) => {
            var hook = new Hook(hookConfig, 'beforeDelete')
            var hookError = {}

            Promise.resolve(hook.apply(current, deletedDocs, hookError, this.schema, this.name, req)).then((newQuery) => {
              callback((newQuery === null) ? {} : null, newQuery)
            }).catch((err) => {
              callback(hook.formatError(err))
            })
          }, (err, result) => {
            if (err) {
              done(err)
            } else {
              deleteDocuments(this.connection.db)
            }
          })
        } else {
          deleteDocuments(this.connection.db)
        }
      }).catch((err) => {
        logger.error({module: 'model'}, err)

        done(err)
      })
    })
  })
}

/**
 * Lookup documents in the database
 *
 * @param {Object} query
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.find = function (query, options, done) {
  if (typeof options === 'function') {
    done = options
    options = {}
  }

  var self = this

  // Set up a queue of functions to run before finally sending
  // data back to the client
  var doneQueue = []

  var runDoneQueue = function (err, data) {
    if (doneQueue.length > 0) {
      // Assign err, data to the first function
      doneQueue.splice(0, 0, async.apply(assignVariables, err, data))

      async.waterfall(doneQueue, function (arg1, err, data) {
        return done(err, data)
      })
    } else {
      // Nothing queued, send data back
      return done(err, data)
    }
  }

  // Assign (err, data) variables to the first function in the queue
  function assignVariables (err, data, callback) {
    callback(null, err, data)
  }

  // Queue the history resolving function
  if (options.includeHistory) {
    doneQueue.push((err, data, callback) => {
      if (err) {
        return callback(null, err, data)
      } else {
        this.injectHistory(data, options).then((data) => {
          return callback(null, err, data)
        })
      }
    })

    delete options.includeHistory
  }

  query = queryUtils.makeCaseInsensitive(query, self.schema)

  debug('find %o %o', query, options)

  // override the model's settings with a value from the options object
  if (options.hasOwnProperty('compose')) {
    self.compose = options.compose
    delete options.compose
  }

  var validation = this.validate.query(query)

  if (!validation.success) {
    var err = createValidationError('Bad Query')
    err.json = validation
    return done(err)
  }

  var _done = (database) => {
    if (queryUtils.containsNestedReferenceFields(query, this.schema)) {
      var queries = queryUtils.processReferenceFieldQuery(query, this.schema)

      debug('find reference %o', queries)

      // processReferenceFieldQuery sends back an array of queries
      // [0] is the query with reference field parts removed
      // [1] contains the reference field parts
      query = queries[0]

      var referenceFieldQuery = queries[1]
      var referenceFieldKeys = Object.keys(referenceFieldQuery)
      var queue = []

      // for each reference field key, query the specified collection
      // to obtain an _id value
      referenceFieldKeys.forEach((key, index) => {
        queue.push((cb) => {
          var keyParts = key.split('.')

          var collection = ''
          var collectionKey = keyParts[0]
          var linkKey
          var queryKey
          var queryValue = referenceFieldQuery[key]
          var collectionSettings = queryUtils.getSchemaOrParent(collectionKey, this.schema).settings || {}
          var collectionLevelCompose = true

          if (collectionKey !== collectionSettings.collection) {
            collection = collectionSettings.collection
          } else {
            collection = collectionKey
          }

          var fieldsObj = {}
          if (collectionSettings.fields) {
            collectionSettings.fields.forEach(field => {
              fieldsObj[field] = 1
            })
          }

          queryKey = keyParts[1]
          var collectionQuery = {}

          if (keyParts.length === 2) {
            collectionQuery[queryKey] = queryValue
          } else {
            linkKey = keyParts[1]
            queryKey = keyParts[2]
          }

          // if we already have a value for this field inserted
          // into the final query object (e.g. a parent nested query has been done first),
          // supplement the current query with the ids
          if (query[collectionKey]) {
            collectionQuery['_id'] = query[collectionKey]
          }

          // query the reference collection
          debug('find reference in %s with %o', collection, collectionQuery)

          var referenceModel = new Model(collection, {}, null, { database: collectionSettings.database || self.settings.database, compose: collectionLevelCompose })

          referenceModel.find(collectionQuery, { fields: fieldsObj }, (err, results) => {
            if (err) return done(err)

            var ids = []

            if (results && results.results && results.results.length) {
              results = results.results

              if (!linkKey) { // i.e. it's a one-level nested query
                ids = _.map(_.pluck(results, '_id'), (id) => { return id.toString() })

                // update the original query with a query for the obtained _id
                // using the appropriate query type for whether the reference settings
                // allows storing as arrays or not
                query[collectionKey] = collectionSettings.multiple ? { '$containsAny': ids } : ids[0]
                // query[collectionKey] = collectionSettings.multiple ? { '$in': ids } : ids[0]
              } else {
                // filter the results using linkKey
                // 1. get the _id of the result matching { queryKey: queryValue }
                var parents = _.filter(results, result => {
                  return new RegExp(queryValue).test(result[queryKey]) === true
                })

                // check every parent category for any children that belong to them
                for (var p = 0; p < parents.length; p++) {
                  var children = _.filter(results, result => {
                    if (result[linkKey]) {
                      if (typeof result[linkKey] === 'string' && result[linkKey].toString() === parents[p]._id.toString()) {
                        return result
                      } else if (typeof result[linkKey] === 'object') {
                        if (result[linkKey].toString() === '[object Object]' && result[linkKey]._id.toString() === parents[p]._id.toString()) {
                          return result
                        } else if (result[linkKey].toString() === parents[p]._id.toString()) {
                          return result
                        }
                      }
                    }
                  })

                  var childIds = _.map(_.pluck(children, '_id'), id => {
                    return id.toString()
                  })

                  ids = ids.concat(childIds)
                }

                query[collectionKey] = { '$in': ids || [] }
              }
            } else {
              // Nothing found in the reference collection, add empty criteria to the main query
              query[collectionKey] = collectionSettings.multiple
                ? { '$in': [] }
                : ''
            }

            cb(null, query)
          })
        })
      })
      // })

      async.series(queue,
        function (err, results) {
          if (err) {
            logger.error({module: 'model'}, err)
          }

          runFind()
        }
      )
    } else {
      runFind()
    }

    // perform the actual find operation
    function runFind () {
      var queryOptions = _.clone(options)
      delete queryOptions.historyFilters

      database.find({
        query: query,
        collection: self.name,
        options: queryOptions,
        schema: self.schema,
        settings: self.settings
      }).then(results => {
        // NOTE: datastore returns object containing results + metadata
        //  {
        //    results: [ { _id: 590bbc9d29ccaf1cb8ab0ed1, fieldName: 'foo' } ],
        //    metadata: { page: 1, offset: 0, totalCount: 1, totalPages: 1 }
        //  }

        if (self.compose) {
          self.composer.setApiVersion(query._apiVersion)

          self.composer.compose(results.results, (obj) => {
            results.results = obj
            runDoneQueue(null, results)
          })
        } else {
          runDoneQueue(null, results)
        }
      }).catch(err => {
        if (err.message === 'DB_DISCONNECTED') {
          return done(createConnectionError())
        }

        return done(err)
      })
    }
  }

  if (!this.connection.db) {
    return done(createConnectionError())
  }

  return _done(this.connection.db)
}

/**
 * Lookup documents in the database based on search query and run any associated hooks
 *
 * @param {Object} query
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.search = function (options, done, req) {
  let err

  if (typeof options === 'function') {
    done = options
    options = {}
  }

  if (!this.searchHandler.canUse()) {
    err = new Error('Not Implemented')
    err.statusCode = 501
    err.json = {
      errors: [{
        message: `Search is disabled or an invalid data connector has been specified.`
      }]
    }
  } else if (!options.search || options.search.length < config.get('search.minQueryLength')) {
    err = new Error('Bad Request')
    err.statusCode = 400
    err.json = {
      errors: [{
        message: `Search query must be at least ${config.get('search.minQueryLength')} characters.`
      }]
    }
  }

  if (err) {
    return done(err, null)
  }

  this.searchHandler.find(options.search).then(query => {
    let ids = query._id['$containsAny'].map(id => id.toString())

    this.get(query, options, (err, results) => {
      results.results = results.results.sort((a, b) => {
        let aIndex = ids.indexOf(a._id.toString())
        let bIndex = ids.indexOf(b._id.toString())

        if (aIndex === bIndex) return 0

        return aIndex < bIndex ? -1 : 1
      })

      return done(err, results)
    }, req)
  }).catch(err => {
    return done(err)
  })
}

/**
 * Performs a last round of formatting to the query before it's
 * delivered to the data adapters
 *
 * @param {Object} query
 * @return An object representing the formatted query
 * @api public
 */
Model.prototype.formatQuery = function (query) {
  const internalFieldsPrefix = config.get('internalFieldsPrefix')
  let newQuery = {}

  Object.keys(query).forEach(key => {
    if (
      internalFieldsPrefix !== '_' &&
      key.indexOf(internalFieldsPrefix) === 0
    ) {
      newQuery['_' + key.slice(1)] = query[key]
    } else {
      newQuery[key] = query[key]
    }
  })

  return newQuery
}

/**
 * Formats a result for being sent to the client (formatForInput = false)
 * or to be fed into the model (formatForInput = true)
 *
 * @param {Object} results
 * @param {Boolean} formatForInput
 * @return An object/array of objects representing the prepared documents
 * @api private
 */
Model.prototype.formatResultSet = function (results, formatForInput) {
  const multiple = Array.isArray(results)
  const documents = multiple ? results : [results]
  const prefixes = {
    from: formatForInput
      ? config.get('internalFieldsPrefix')
      : '_',
    to: formatForInput
      ? '_'
      : config.get('internalFieldsPrefix')
  }

  let newResultSet = []

  documents.forEach(document => {
    let newDocument = {}

    Object.keys(document).sort().forEach(field => {
      const property = field.indexOf(prefixes.from) === 0
        ? prefixes.to + field.slice(1)
        : field

      // Stripping null values from the response.
      if (document[field] !== null) {
        newDocument[property] = document[field]
      }
    })

    newResultSet.push(newDocument)
  })

  return multiple ? newResultSet : newResultSet[0]
}

/**
 * Formats a result set before it's fed into the model for insertion/update.
 *
 * @param {Object} results
 * @return An object/array of objects representing the formatted result set
 * @api public
 */
Model.prototype.formatResultSetForInput = function (results) {
  return this.formatResultSet(results, true)
}

/**
 * Formats a result set before it's sent to the client.
 *
 * @param {Object} results
 * @return An object/array of objects representing the formatted result set
 * @api public
 */
Model.prototype.formatResultSetForOutput = function (results) {
  return this.formatResultSet(results, false)
}

Model.prototype.revisions = function (id, options, done) {
  var fields = options.fields || {}
  var historyQuery = {}

  if (options.historyFilters) {
    try {
      historyQuery = JSON.parse(options.historyFilters)
    } catch (e) {}
  }

  var _done = (database) => {
    database.find({
      query: { '_id': id },
      collection: this.name,
      options: { history: 1, limit: 1 },
      schema: this.schema,
      settings: this.settings
    }).then(results => {
      debug('find in history %o', results.results)

      if (results && results.results && results.results.length && this.history) {
        historyQuery._id = {
          '$in': _.map(results.results[0]._history, (id) => {
            return id.toString()
          })
        }

        database.find({
          query: historyQuery,
          collection: this.revisionCollection,
          options: fields,
          schema: this.schema,
          settings: this.settings
        }).then(results => {
          return done(null, results.results)
        }).catch((err) => {
          return done(err)
        })
      } else {
        return done(null, [])
      }
    }).catch((err) => {
      return done(err)
    })
  }

  if (this.connection.db) return _done(this.connection.db)

  // if the db is not connected queue the find
  this.connection.once('connect', function (database) {
    _done(database)
  })
}

/**
 * Lookup documents in the database and run any associated hooks
 *
 * @param {Object} query
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.get = function (query, options, done, req) {
  if (typeof options === 'function') {
    done = options
    options = {}
  }

  const databaseGet = query => {
    this.find(query, options, (err, results) => {
      if (err) return done(err)

      if (this.settings.hooks && this.settings.hooks.afterGet) {
        async.reduce(this.settings.hooks.afterGet, results, (current, hookConfig, callback) => {
          var hook = new Hook(hookConfig, 'afterGet')

          Promise.resolve(hook.apply(current, this.schema, this.name, req)).then(newResults => {
            callback((newResults === null) ? {} : null, newResults)
          }).catch(err => {
            callback(hook.formatError(err))
          })
        }, (err, finalResult) => {
          // Prepare result set for output
          finalResult.results = this.formatResultSetForOutput(finalResult.results)

          done(err, finalResult)
        })
      } else {
        // Prepare result set for output
        results.results = this.formatResultSetForOutput(results.results)

        done(err, results)
      }
    })
  }

  // Run any `beforeGet` hooks
  if (this.settings.hooks && this.settings.hooks.beforeGet) {
    async.reduce(this.settings.hooks.beforeGet, query, (current, hookConfig, callback) => {
      var hook = new Hook(hookConfig, 'beforeGet')

      Promise.resolve(hook.apply(current, this.schema, this.name, req)).then(newQuery => {
        callback(null, newQuery)
      }).catch(err => {
        callback(hook.formatError(err))
      })
    }, (err, finalQuery) => {
      if (err) {
        return done(err, null)
      }

      databaseGet(finalQuery)
    })
  } else {
    databaseGet(query)
  }
}

/**
 *
 */
Model.prototype.getIndexes = function (done) {
  var _done = database => {
    database.getIndexes(this.name).then(result => {
      done(result)
    })
  }

  if (!this.connection.db) {
    this.connection.once('connect', _done)
  } else {
    return _done(this.connection.db)
  }
}

/**
 * Attaches the full history of each document
 * before returning the results
 */
Model.prototype.injectHistory = function (data, options) {
  return new Promise((resolve, reject) => {
    if (data.results.length === 0) {
      return resolve(data)
    }

    data.results.forEach((doc, idx) => {
      this.revisions(doc._id, options, (err, history) => {
        if (err) logger.error({module: 'model'}, err)

        doc._history = this.formatResultSetForOutput(history)

        if (idx === data.results.length - 1) {
          return resolve(data)
        }
      })
    })
  })
}

/**
 * Determines whether the given string is a valid key for
 * the model
 *
 * @param {String} key
 * @return A Boolean indicating whether the key is valid
 * @api public
 */
Model.prototype.isKeyValid = function (key) {
  if (key === '_id' || this.schema[key] !== undefined) {
    return true
  }

  // Check for dot notation so we can determine the datatype
  // of the first part of the key.
  if (key.indexOf('.') > 0) {
    const keyParts = key.split('.')

    if (this.schema[keyParts[0]] !== undefined) {
      if (/Mixed|Object|Reference/.test(this.schema[keyParts[0]].type)) {
        return true
      }
    }
  }
}

/**
 * Get collection statistics
 *
 * @param {Object} options
 * @return An object representing the database collection stats
 * @api public
 */
Model.prototype.stats = function (options, done) {
  options = options || {}

  var _done = (database) => {
    database.stats(this.name, options).then((results) => {
      done(null, results)
    }).catch((err) => {
      // 'Not implemented'
      done(err)
    })
  }

  if (this.connection.db) return _done(this.connection.db)

  this.connection.once('connect', (database) => {
    _done(database)
  })
}

/**
 * Update a document in the database
 *
 * @param {Object} query
 * @param {Object} update
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.update = function (query, update, internals, done, req, bypassOutputFormatting) {
  debug('update %s %o %o %o', req ? req.url : '', query, update, internals)

  // internals will not be validated, i.e. should not be user input
  if (typeof internals === 'function') {
    done = internals
  }

  if (!this.connection.db) {
    return done(createConnectionError())
  }

  let err

  let validation = this.validate.query(query)

  if (!validation.success) {
    err = createValidationError('Bad Query')
    err.json = validation
    return done(err)
  }

  validation = this.validate.schema(update, true)

  if (!validation.success) {
    err = createValidationError()
    err.json = validation
    return done(err)
  }

  // Format query
  query = this.formatQuery(query)

  // Is this a RESTful query by ID?
  const isRestIDQuery = req && req.params.id

  // DateTimes
  update = queryUtils.convertDateTimeForSave(this.schema, update)

  if (typeof internals === 'object' && internals != null) { // not null and not undefined
    Object.assign(update, internals)
  }

  this.composer.setApiVersion(internals._apiVersion)

  const setUpdate = { $set: update, $inc: { _version: 1 } }

  // get a reference to the documents that will be updated
  let updatedDocs = []

  this.find(query, {}, (err, result) => {
    if (err) return done(err)

    // create a copy of the documents that matched the find
    // query, as these will be updated and we need to send back to the
    // client a full result set of modified documents
    updatedDocs = queryUtils.snapshot(result.results)

    this.composer.createFromComposed(update, req, (err, result) => {
      if (err) {
        return done(err.json)
      }

      return startUpdate(this.connection.db)
    })
  })

  const startUpdate = (database) => {
    this.find(query, { compose: false }, (err, result) => {
      if (err) return done(err)

      const saveDocuments = () => {
        database.update({
          query: query,
          collection: this.name,
          update: setUpdate,
          options: { multi: true },
          schema: this.schema
        }).then((result) => {
          if (isRestIDQuery && (result.matchedCount === 0)) {
            err = new Error('Not Found')
            err.statusCode = 404

            return done(err)
          }

          const triggerAfterUpdateHook = (docs) => {
            if (this.settings.hasOwnProperty('hooks') && (typeof this.settings.hooks.afterUpdate === 'object')) {
              this.settings.hooks.afterUpdate.forEach((hookConfig, index) => {
                const hook = new Hook(this.settings.hooks.afterUpdate[index], 'afterUpdate')

                return hook.apply(docs, this.schema, this.name)
              })
            }
          }

          let promise

          // for each of the updated documents, create a history revision for it
          if (this.history) {
            promise = this.history.createEach(updatedDocs, 'update', this)
          } else {
            promise = Promise.resolve()
          }

          promise.then(() => {
            const query = {
              _id: {
                '$in': updatedDocs.map(doc => { return doc._id.toString() })
              }
            }

            return this.find(query, { compose: true }, (err, results) => {
              if (err) return done(err)

              if (result.matchedCount === 0) return done(null, results)

              // apply any existing `afterUpdate` hooks
              triggerAfterUpdateHook(results.results)

              // asynchronous search index
              this.searcher.index(results.results)

              // Prepare result set for output
              if (!bypassOutputFormatting) {
                results.results = this.formatResultSetForOutput(results.results)
              }

              return done(null, results)
            })
          }).catch((err) => {
            logger.error({module: 'model'}, err)
          })
        }).catch((err) => {
          return done(err)
        })
      }

      // apply any existing `beforeUpdate` hooks, otherwise save the documents straight away
      if (this.settings.hooks && this.settings.hooks.beforeUpdate) {
        async.reduce(this.settings.hooks.beforeUpdate, update, (current, hookConfig, callback) => {
          const hook = new Hook(hookConfig, 'beforeUpdate')

          Promise.resolve(hook.apply(current, updatedDocs, this.schema, this.name, req)).then((newUpdate) => {
            callback((newUpdate === null) ? {} : null, newUpdate)
          }).catch(err => {
            callback(hook.formatError(err))
          })
        }, (err, result) => {
          if (err) {
            done(err)
          } else {
            update = result
            saveDocuments()
          }
        })
      } else {
        saveDocuments()
      }
    })
  }
}

function createConnectionError () {
  const err = formatError.createApiError('0004')
  err.statusCode = 503

  return err
}

function createValidationError (message) {
  const err = new Error(message || 'Model Validation Failed')
  err.statusCode = 400

  return err
}

// exports
module.exports = function (name, schema, conn, settings) {
  if (schema) return new Model(name, schema, conn, settings)
  return _models[name]
}

module.exports.Model = Model
