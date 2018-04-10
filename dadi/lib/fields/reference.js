const objectPath = require('object-path')

module.exports.type = 'reference'

/**
 * Creates an array of Model instances corresponding to a
 * field query, potentially including dot-notation.
 *
 * @param  {Model} rootModel - instance of the base/root model
 * @param  {Array<String>} fields - array of node fields
 * @return {Array<Model>}
 */
function createModelChain (rootModel, fields) {
  return fields.reduce((chain, field, index) => {
    // Propagating an error state.
    if (chain === null) return chain

    if (chain.length === 0) {
      return chain.concat(rootModel)
    }

    let nodeModel = chain[chain.length - 1]
    let referenceField = nodeModel.getField(
      fields[index - 1].split('@')[0]
    )

    // Validating the node and flagging an error if invalid.
    if (
      !referenceField.type ||
      !referenceField.type.length ||
      referenceField.type.toLowerCase() !== 'reference'
    ) {
      return null
    }

    let referenceCollection = field.split('@')[1] ||
      (referenceField.settings && referenceField.settings.collection)

    // If there isn't a `settings.collection` property, we're
    // dealing with a self-reference.
    if (!referenceCollection) {
      return chain.concat(nodeModel)
    }

    let referenceModel = rootModel.getForeignModel(
      referenceCollection
    )

    return chain.concat(referenceModel)
  }, [])
}

module.exports.beforeOutput = function ({
  composeOverride,
  document,
  dotNotationPath = [],
  field,
  input,
  level = 1,
  urlFields = {}
}) {
  let shouldCompose = this.shouldCompose({
    composeOverride,
    level
  })

  // We don't want to do anything if the value is falsy or if
  // composition is disabled, either globally or for this level
  // of nesting.
  if (!input || !input[field] || !shouldCompose) {
    return input
  }

  let isArray = Array.isArray(input[field])

  // We don't want to do anything if the value is an empty array.
  if (isArray && input[field].length === 0) {
    return input
  }

  let newDotNotationPath = dotNotationPath.concat(field)
  let schema = this.getField(field)
  let isStrictCompose = schema.settings &&
    Boolean(schema.settings.strictCompose)
  let values = Array.isArray(input[field])
    ? input[field]
    : [input[field]]
  let ids = values
  let idMappingField = this._getIdMappingName(field)

  // If strict compose is not enabled, we want to resolve duplicates.
  if (!isStrictCompose) {
    ids = ids.filter((id, index) => {
      return id && ids.lastIndexOf(id) === index
    })
  }

  // This generates an object mapping document IDs to collections, so
  // that we can batch requests instead of making one per ID.
  let referenceCollections = ids.reduce((collections, id) => {
    let idMapping = document[idMappingField] || {}
    let referenceCollection = idMapping[id] ||
      (schema.settings && schema.settings.collection) ||
      this.name

    collections[referenceCollection] = collections[referenceCollection] || []
    collections[referenceCollection].push(id)

    return collections
  }, {})

  let documents = {}
  let queryOptions = {}

  // Looking at the `settings.fields` array to determine which fields
  // will be requested from the composed document.
  if (schema.settings && Array.isArray(schema.settings.fields)) {
    // Transforming something like:
    //
    // ["name", "address", "age"]
    //
    // ... into something like:
    //
    // {"name": 1, "address": 1, "age": 1}
    queryOptions.fields = schema.settings.fields.reduce((fieldsObject, field) => {
      fieldsObject[field] = 1

      return fieldsObject
    }, {})
  }

  // Looking at the `fields` URL parameter to determine which fields
  // will be requested from the composed document.
  Object.keys(urlFields).forEach(fieldPath => {
    let fieldPathNodes = fieldPath.split('.')

    if (fieldPath.indexOf(newDotNotationPath.join('.')) === 0) {
      let field = fieldPathNodes[level]

      if (field) {
        queryOptions.fields = queryOptions.fields || {}
        queryOptions.fields[field] = urlFields[fieldPath]
      }
    }
  })

  if (queryOptions.fields) {
    queryOptions.fields[idMappingField] = 1
  }

  return Promise.all(
    Object.keys(referenceCollections).map(collection => {
      let model = collection === this.name
        ? this
        : this.getForeignModel(collection)

      if (!model) return

      return model.find({
        options: queryOptions,
        query: {
          _id: {
            $containsAny: referenceCollections[collection]
          }
        }
      }).then(({metadata, results}) => {
        return Promise.all(
          results.map(result => {
            return model.formatForOutput(result, {
              composeOverride,
              dotNotationPath: newDotNotationPath,
              level: level + 1,
              urlFields
            }).then(formattedResult => {
              documents[result._id] = formattedResult
            })
          })
        )
      })
    })
  ).then(() => {
    let composedIds = []
    let resolvedDocuments = ids.map(id => {
      if (documents[id]) {
        composedIds.push(ids)

        return documents[id]
      }

      return isStrictCompose ? null : id
    })

    // If strict compose is not enabled, we remove falsy values.
    if (!isStrictCompose) {
      resolvedDocuments = resolvedDocuments.filter(Boolean)
    }

    // Returning a single object if that's how it's represented
    // in the database.
    if (!isArray) {
      resolvedDocuments = resolvedDocuments[0]
    }

    let output = {
      [field]: resolvedDocuments
    }

    if (composedIds.length > 0) {
      output._composed = {
        [field]: input[field]
      }
    }

    return output
  })
}

module.exports.beforeQuery = function ({config, field, input, options}) {
  let isOperatorQuery = tree => {
    return Boolean(
      tree &&
      Object.keys(tree).every(key => {
        return key[0] === '$'
      })
    )
  }

  if (isOperatorQuery(input[field])) {
    return input
  }

  // This will take an object that maps dot-notation paths to values
  // and return a tree representation of that. For example:
  //
  // In:
  // {
  //   "book.title": "For Whom The Bell Tolls",
  //   "book.author.occupation": "writer",
  //   "book.author.name": "Ernest Hemingway"
  // }
  //
  // Out:
  // {
  //   "book": {
  //     "title": "For Whom The Bell Tolls",
  //     "author": {
  //       "occupation": "writer",
  //       "name": "Ernest Hemingway"
  //     }
  //   }
  // }
  let inputTree = Object.keys(input).reduce((tree, path) => {
    objectPath.set(tree, path, input[path])

    return tree
  }, {})

  // This function takes a tree like the one in the example above and
  // processes it recursively, running the `find` method in the
  // appropriate models.
  let processTree = (tree, path = []) => {
    let queue = Promise.resolve({})

    Object.keys(tree).forEach(key => {
      let canonicalKey = key.split('@')[0]

      queue = queue.then(query => {
        if (
          tree[key] &&
          typeof tree[key] === 'object' &&
          !isOperatorQuery(tree[key])
        ) {
          return processTree(
            tree[key],
            path.concat(key)
          ).then(result => {
            return Object.assign({}, query, {
              [canonicalKey]: result
            })
          })
        }

        return Object.assign({}, query, {
          [canonicalKey]: tree[key]
        })
      })
    })

    let firstKey = Object.keys(tree)[0]
    let modelChain = createModelChain(this, path.concat(firstKey))
    let model = modelChain[modelChain.length - 1]

    return queue.then(query => {
      if (path.length === 0) {
        return query
      }

      // This is a little optimisation. If the current query didn't yield
      // any results, there's no point in processing any nodes to the left
      // because the result will always be an empty array.
      Object.keys(query).forEach(field => {
        if (query[field].$containsAny && query[field].$containsAny.length === 0) {
          return {
            $containsAny: []
          }
        }
      })

      return model.find({
        query
      }).then(({results}) => {
        return {
          $containsAny: results.map(item => item._id.toString())
        }
      })
    })
  }

  return processTree(inputTree)
}

module.exports.beforeSave = function ({
  config,
  field,
  internals,
  input,
  schema
}) {
  let isArray = Array.isArray(input[field])
  let values = isArray
    ? input[field]
    : [input[field]]
  let idMapping = {}
  let insertions = values.map(value => {
    // This is an ID or it's falsy, there's nothing left to do.
    if (!value || typeof value === 'string') {
      return value
    }

    let needsMapping = false
    let collectionField = `${config.get('internalFieldsPrefix')}collection`
    let dataField = `${config.get('internalFieldsPrefix')}data`
    let referenceCollection

    // Are we looking at the multi-collection reference format?
    if (value[collectionField] && value[dataField]) {
      referenceCollection = value[collectionField]
      value = value[dataField]

      // If the value of `_data` is a string, we assume it's an
      // ID and therefore we just need to add the collection name
      // to the mapping and we're done.
      if (typeof value === 'string') {
        idMapping[value] = referenceCollection

        return value
      }

      needsMapping = true
    } else {
      referenceCollection = schema.settings &&
        schema.settings.collection
    }

    let model = referenceCollection
      ? this.getForeignModel(referenceCollection)
      : this

    // Augment the value with the internal properties from the parent.
    Object.assign(value, internals)

    return model.formatForInput(
      value,
      {internals}
    ).then(document => {
      // The document has an ID, so it's an update.
      if (document._id) {
        return model.update({
          internals: Object.assign({}, internals, {
            _lastModifiedBy: internals._createdBy
          }),
          query: {
            _id: document._id
          },
          rawOutput: true,
          update: document
        }).then(response => document._id)
      }

      return model.create({
        documents: document,
        internals,
        rawOutput: true
      }).then(({results}) => {
        return results[0]._id.toString()
      })
    }).then(id => {
      if (needsMapping) {
        idMapping[id] = referenceCollection
      }

      return id
    })
  })

  return Promise.all(insertions).then(value => {
    return {
      [this._getIdMappingName(field)]: idMapping,
      [field]: isArray ? value : value[0]
    }
  })
}
