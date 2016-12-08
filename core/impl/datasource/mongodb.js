// jscs:disable requireCapitalizedComments
/**
 * Created by kras on 25.02.16.
 */
'use strict';

const DataSource = require('core/interfaces/DataSource');
const mongo = require('mongodb');
const client = mongo.MongoClient;
const LoggerProxy = require('core/impl/log/LoggerProxy');
const empty = require('core/empty');

const AUTOINC_COLLECTION = '__autoinc';

// jshint maxstatements: 50, maxcomplexity: 20

/**
 * @param {{ uri: String, options: Object }} config
 * @constructor
 */
function MongoDs(config) {

  var _this = this;

  /**
   * @type {Db}
   */
  this.db = null;

  this.isOpen = false;

  this.busy = false;

  var log = config.logger || new LoggerProxy();

  var excludeNullsFor = {};

  /**
   * @returns {Promise}
   */
  this.openDb = function () {
    return new Promise(function (resolve, reject) {
      if (_this.db && _this.isOpen) {
        return resolve(_this.db);
      } else if (_this.db && _this.busy) {
        _this.db.once('isOpen', function () {
          resolve(_this.db);
        });
      } else {
        _this.busy = true;
        client.connect(config.uri, config.options, function (err, db) {
          if (err) {
            reject(err);
          }
          try {
            _this.db = db;
            _this.db.open(function () {
              _this.busy = false;
              _this.isOpen = true;
              log.info('Получено соединение с базой: ' + db.s.databaseName + '. URI: ' + db.s.options.url);
              _this._ensureIndex(AUTOINC_COLLECTION, {type: 1}, {unique: true}).then(
                function () {
                  resolve(_this.db);
                  _this.db.emit('isOpen', _this.db);
                }
              ).catch(reject);
            });
          } catch (e) {
            _this.busy = false;
            _this.isOpen = false;
            reject(e);
          }
        });
      }
    });
  };

  this._connection = function () {
    if (this.isOpen) {
      return this.db;
    }
    return null;
  };

  this._open = function () {
    return this.openDb();
  };

  this._close = function () {
    return new Promise(function (resolve, reject) {
      if (_this.db && _this.isOpen) {
        _this.busy = true;
        _this.db.close(true, function (err) {
          _this.isOpen = false;
          _this.busy = false;
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  };

  /**
   * @param {String} type
   * @returns {Promise}
   */
  this.getCollection = function (type) {
    return new Promise(function (resolve, reject) {
      _this.openDb().then(function () {
        // Здесь мы перехватываем автосоздание коллекций, чтобы вставить хук для создания индексов, например
        _this.db.collection(type, {strict: true}, function (err, c) {
          if (!c) {
            try {
              _this.db.createCollection(type)
                .then(resolve)
                .catch(reject);
            } catch (e) { // Для отлавливания ошибки, при падении системы - закрывается БД и основная ошибка не выводится, а выводится вторичная от создания коллекции на закрытой базе "TypeError: callback is not a function"
              return reject(err);
            }
          } else {
            if (err) {
              return reject(err);
            }
            resolve(c);
          }
        });
      }).catch(reject);
    });
  };

  this._delete = function (type, conditions) {
    return this.getCollection(type).then(
      function (c) {
        return new Promise(function (resolve, reject) {
          c.deleteMany(conditions,
            function (err, result) {
              if (err) {
                return reject(err);
              }
              resolve(result.deletedCount);
            });
        });
      }
    );
  };

  function getAutoInc(type) {
    return new Promise(function (resolve, reject) {
      _this.getCollection(AUTOINC_COLLECTION).then(
        /**
         * @param {Collection} autoinc
         */
        function (autoinc) {
          autoinc.find({type: type}).limit(1).next(function (err, counters) {
            if (err) {
              return reject(err);
            }
            resolve({ai: autoinc, c: counters});
          });
        }
      ).catch(reject);
    });
  }

  function autoInc(type, data) {
    return new Promise(function (resolve, reject) {
      getAutoInc(type).then(
        /**
         * @param {{ai: Collection, c: {counters:{}, steps:{}}}} result
         */
        function (result) {
          if (result.c && result.c.counters) {
            var inc = {};
            var act = false;
            var counters = result.c.counters;
            for (var nm in counters) {
              if (counters.hasOwnProperty(nm)) {
                inc['counters.' + nm] =
                  result.c.steps && result.c.steps.hasOwnProperty(nm) ? result.c.steps[nm] : 1;
                act = true;
              }
            }

            if (act) {
              result.ai.findOneAndUpdate(
                {type: type},
                {$inc: inc},
                {returnOriginal: false, upsert: false},
                function (err, result) {
                  if (err) {
                    return reject(err);
                  }

                  for (var nm in result.value.counters) {
                    if (result.value.counters.hasOwnProperty(nm)) {
                      data[nm] = result.value.counters[nm];
                    }
                  }
                  resolve(data);
                }
              );
              return;
            }
          }
          resolve(data);
        }
      ).catch(reject);
    });
  }

  function excludeNulls(data, excludes) {
    var nm;
    var unsets = {};
    for (nm in data) {
      if (data.hasOwnProperty(nm)) {
        if (data[nm] === null && excludes.hasOwnProperty(nm)) {
          delete data[nm];
          unsets[nm] = true;
        }
      }
    }
    return {data: data, unset: unsets};
  }

  /**
   * @param {Collection} c
   * @returns {Promise}
   */
  function cleanNulls(c, type, data) {
    return new Promise(function (resolve, reject) {
      if (excludeNullsFor.hasOwnProperty(type)) {
        resolve(excludeNulls(data, excludeNullsFor[type]));
      } else {
        c.indexes(function (err, indexes) {
          if (err) {
            return reject(err);
          }
          var excludes = {};
          var i, nm;
          for (i = 0; i < indexes.length; i++) {
            if (indexes[i].unique && indexes[i].sparse) {
              for (nm in indexes[i].key) {
                if (indexes[i].key.hasOwnProperty(nm)) {
                  excludes[nm] = true;
                }
              }
            }
          }

          excludeNullsFor[type] = excludes;
          resolve(excludeNulls(data, excludeNullsFor[type]));
        });
      }
    });
  }

  this._insert = function (type, data) {
    return this.getCollection(type).then(
      function (c) {
        return new Promise(function (resolve, reject) {
          autoInc(type, data)
            .then(
              function (data) {
                return cleanNulls(c, type, data);
              }
            ).then(
              function (data) {
                c.insertOne(data.data, function (err, result) {
                  if (err) {
                    reject(err);
                  } else if (result.insertedId) {
                    _this._get(type, {_id: result.insertedId}).then(resolve).catch(reject);
                  } else {
                    reject(new Error('Inser failed'));
                  }
                });
              }
            ).catch(reject);
        });
      }
    );
  };

  function adjustAutoInc(type, data) {
    return new Promise(function (resolve, reject) {
      getAutoInc(type).then(
        /**
         * @param {{ai: Collection, c: {counters:{}, steps:{}}}} result
         */
        function (result) {
          var act = false;
          var up = {};
          if (result.c && result.c.counters) {
            var counters = result.c.counters;
            for (var nm in counters) {
              if (counters.hasOwnProperty(nm)) {
                if (counters[nm] < data[nm]) {
                  up['counters.' + nm] = data[nm];
                  act = true;
                }
              }
            }
          }

          if (!act) {
            return resolve(data);
          }

          result.ai.findOneAndUpdate(
            {type: type},
            {$set: up},
            {returnOriginal: false, upsert: false},
            function (err) {
              if (err) {
                return reject(err);
              }
              resolve(data);
            }
          );
          return;
        }
      ).catch(reject);
    });
  }

  this.doUpdate = function (type, conditions, data, upsert, multi) {
    var hasData = false;
    if (data) {
      for (var nm in data) {
        if (data.hasOwnProperty(nm) &&
          typeof data[nm] !== 'undefined' &&
          typeof data[nm] !== 'function'
        ) {
          hasData = nm;
          break;
        }
      }
    }

    if (!hasData) {
      return _this._get(type, conditions);
    }

    return this.getCollection(type).then(
      function (c) {
        return cleanNulls(c, type, data)
          .then(
            function (data) {
              return new Promise(function (resolve, reject) {
                var updates = {};
                if (!empty(data.data)) {
                  updates.$set = data.data;
                }
                if (!empty(data.unset)) {
                  updates.$unset = data.unset;
                }
                if (!multi) {
                  c.updateOne(
                    conditions,
                    updates,
                    {upsert: upsert},
                    function (err) {
                      if (err) {
                        return reject(err);
                      }
                      _this._get(type, conditions).then(function (r) {
                        if (upsert) {
                          return adjustAutoInc(type, r);
                        }
                        return resolve(r);
                      }).then(resolve).catch(reject);
                    });
                } else {
                  c.updateMany(conditions, updates,
                    function (err, result) {
                      if (err) {
                        return reject(err);
                      }
                      _this._fetch(type, {filter: conditions}).then(resolve).catch(reject);
                    });
                }
              });
            }
          );
      });
  };

  this._update = function (type, conditions, data) {
    return this.doUpdate(type, conditions, data, false, false);
  };

  this._upsert = function (type, conditions, data) {
    return this.doUpdate(type, conditions, data, true, false);
  };

  /**
   * @param {String[]} attributes
   * @param {{}} find
   * @param {Object[]} exists
   * @returns {*}
     */
  function produceMatchObject(attributes, find, exists) {
    var result, tmp, i;
    if (Array.isArray(find)) {
      result = [];
      for (i = 0; i < find.length; i++) {
        tmp = produceMatchObject(attributes, find[i], exists);
        if (tmp) {
          result.push(tmp);
        }
      }
      return result.length ? result : null;
    } else if (typeof find === 'object') {
      result = null;
      var arrFld;
      for (var name in find) {
        if (find.hasOwnProperty(name)) {
          if (name === '$joinExists') {
            if (find[name].many) {
              if (!attributes || !attributes.length) {
                throw new Error('Не передан список атрибутов необходимый для выполнения объединения многие-ко-многим.');
              }
              exists.push({$unwind: '$' + find[name].left});
            }
            tmp = {
              from: find[name].table,
              localField: find[name].left,
              foreignField: find[name].right
            };
            arrFld = '_join_check';
            tmp.as = arrFld;
            exists.push({$lookup: tmp});
            tmp = {};
            tmp[arrFld] = {$elemMatch: find[name].filter};
            exists.push({$match: tmp});

            if (find[name].many) {
              tmp = {};
              for (i = 0; i < attributes.length; i++) {
                if (attributes[i] !== find[name].left) {
                  tmp[attributes[i]] = '$' + attributes[i];
                }
              }
              tmp = {_id: tmp};
              tmp[find[name].left] = {$addToSet: '$' + find[name].left};
              exists.push({$group: tmp});
            }
          } else {
            tmp = produceMatchObject(attributes, find[name], exists);
            if (tmp) {
              if (!result) {
                result = {};
              }
              result[name] = tmp;
            }
          }
        }
      }
      return result;
    }
    return find;
  }

  /**
   * @param {{}} options
   * @param {String[]} [options.attributes]
   * @param {{}} [options.filter]
   * @param {{}} [options.sort]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Boolean} [options.countTotal]
   * @param {Boolean} [options.distinct]
   * @returns {*}
   */
  function checkAggregation(options) {
    var i;
    var dstnct = {};
    if (options.distinct) {
      for (i = 0; i < options.attributes.length; i++) {
        dstnct[options.attributes[i]] = '$' + options.attributes[i];
      }
      dstnct = {$group: {_id: dstnct}};
    }
    if (options.filter) {
      var exists = [];
      var match = produceMatchObject(options.attributes, options.filter, exists);
      if (exists.length) {
        var result = [];
        result.push({$match: match});
        result = result.concat(exists);

        if (options.countTotal) {
          if (!options.attributes || !options.attributes.length) {
            throw new Error('Не передан список атрибутов необходимый для подсчета размера выборки.');
          }

          var tmp = {};
          for (i = 0; i < options.attributes.length; i++) {
            tmp[options.attributes[i]] = 1;
          }

          tmp.__total = {$sum: 1};

          result.push({
            $project: tmp
          });
        }

        if (options.distinct) {
          result.push(dstnct);
        }

        if (options.sort) {
          result.push({$sort: options.sort});
        }

        if (options.offset) {
          result.push({$skip: options.offset});
        }

        if (options.count) {
          result.push({$limit: options.count});
        }
        return result;
      }
    } else if (options.distinct) {
      return [dstnct];
    }
    return false;
  }

  /**
   * @param {Collection} c
   * @param {{}} options
   * @param {String[]} [options.attributes]
   * @param {{}} [options.filter]
   * @param {{}} [options.sort]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Boolean} [options.countTotal]
   * @param {Boolean} [options.distinct]
   * @param {Object[]} aggregate
   * @param {Function} resolve
   * @param {Function} reject
   */
  function fetch(c, options, aggregate, resolve, reject) {
    var r, flds, i;
    if (aggregate) {
      c.aggregate(aggregate, {}, function (err, data) {
        if (err) {
          return reject(err);
        }
        var results = [];
        if (data.length) {
          for (i = 0; i < data.length; i++) {
            results.push(data[i]);
          }
        }
        if (options.countTotal) {
          results.total = data.length ? data[0].count : 0;
        }
        resolve(results, options.countTotal ? (data.length ? data[0].__total : 0) : null);
      });
    } else if(options.distinct && options.attributes.length === 1) {
      c.distinct(options.attributes.length[0], options.filter || {}, function (err, docs) {
        if (err) {
          return reject(err);
        }
        console.log("Неуверен насчет правильности подсчета общего количества. Возможноли его вообще получить в дистинкте?");
        resolve(docs, options.countTotal ? (docs.length ? docs.length : 0) : null);
      });
    } else {
      flds = null;
      r = c.find(options.filter || {});

      if (options.sort) {
        r = r.sort(options.sort);
      }

      if (options.offset) {
        r = r.skip(options.offset);
      }

      if (options.count) {
        r = r.limit(options.count);
      }

      if (options.countTotal) {
        r.count(false, function (err, amount) {
          if (err) {
            r.close();
            return reject(err);
          }
          resolve(r, amount);
        });
      } else {
        resolve(r);
      }
    }

  }

  /**
   * @param {String} type
   * @param {{}} [options]
   * @param {String[]} [options.attributes]
   * @param {{}} [options.filter]
   * @param {{}} [options.sort]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Boolean} [options.countTotal]
   * @returns {Promise}
   */
  this._fetch = function (type, options) {
    options = options || {};
    return this.getCollection(type).then(
      function (c) {
        return new Promise(function (resolve, reject) {
          fetch(c, options, checkAggregation(options),
            function (r, amount) {
              if (Array.isArray(r)) {
                if (amount !== null) {
                  r.total = amount;
                }
                resolve(r);
              } else {
                r.toArray(function (err, docs) {
                  r.close();
                  if (err) {
                    return reject(err);
                  }
                  if (amount !== null) {
                    docs.total = amount;
                  }
                  resolve(docs);
                });
              }
            },
            reject
          );
        });
      }
    );
  };

  /**
   * @param {String} type
   * @param {{}} [options]
   * @param {String[]} [options.attributes]
   * @param {{}} [options.filter]
   * @param {{}} [options.sort]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Number} [options.batchSize]
   * @param {Function} cb
   * @returns {Promise}
   */
  this._forEach = function (type, options, cb) {
    options = options || {};
    return this.getCollection(type).then(
      function (c) {
        return new Promise(function (resolve, reject) {
          try {
            fetch(c, options, checkAggregation(options),
              function (r, amount) {
                if (Array.isArray(r)) {
                  r.forEach(cb);
                } else {
                  r.batchSize(options.batchSize || 1);
                  r.forEach(
                    cb,
                    function (err) {
                      r.close();
                      if (err) {
                        return reject(err);
                      }
                      resolve();
                    }
                  );
                }
              }, reject
            );
          } catch (err) {
            reject(err);
          }
        });
      }
    );
  };

  /**
   * @param {String} type
   * @param {{expressions: {}}} options
   * @param {{}} [options.filter]
   * @param {{}} [options.grouping]
   * @returns {Promise}
   */
  this._aggregate = function (type, options) {
    options = options || {};
    return this.getCollection(type).then(
      function (c) {
        return new Promise(function (resolve, reject) {
          if (!options.expressions) {
            return reject(new Error('Не указано выражение агрегации!'));
          }
          var i;
          var plan = [];
          if (options.filter) {
            plan.push({
              $match: options.filter
            });
          }

          var groupings = null;
          if (options.groupBy) {
            groupings = {};
            for (i = 0; i < options.groupBy.length; i++) {
              groupings[options.groupBy[i]] = '$' + options.groupBy[i];
            }
          }

          var expr = {
            $group: {
              _id: groupings
            }
          };

          var alias, oper, attr;
          for (alias in options.expressions) {
            if (options.expressions.hasOwnProperty(alias)) {
              for (oper in options.expressions[alias]) {
                if (options.expressions[alias].hasOwnProperty(oper)) {
                  attr = options.expressions[alias][oper];
                  if (oper === 'count') {
                    expr.$group[alias] = {$sum: 1};
                  } else if (oper === 'sum' || oper === 'avg' || oper === 'min' || oper === 'max') {
                    expr.$group[alias] = {};
                    expr.$group[alias]['$' + oper] = '$' + attr;
                  }
                }
              }
            }
          }

          plan.push(expr);

          c.aggregate(plan, function (err, result) {
            if (err) {
              return reject(err);
            }
            resolve(result);
          });
        });
      }
    );
  };

  this._count = function (type, options) {
    return this.getCollection(type).then(
      function (c) {
        return new Promise(function (resolve, reject) {
          var opts = {};
          if (options.offset) {
            opts.skip = options.offset;
          }
          if (options.count) {
            opts.limit = options.count;
          }

          c.count(options.filter || {}, opts, function (err, cnt) {
            if (err) {
              return reject(err);
            }
            resolve(cnt);
          });
        });
      }
    );
  };

  this._get = function (type, conditions) {
    return _this.getCollection(type).then(
      function (c) {
        return new Promise(function (resolve, reject) {
          c.find(conditions).limit(1).next(function (err, result) {
            if (err) {
              return reject(err);
            }
            resolve(result);
          });
        });
      });
  };

  /**
   * @param {String} type
   * @param {{}} properties
   * @param {{unique: Boolean}} [options]
   * @returns {Promise}
   */
  this._ensureIndex = function (type, properties, options) {
    return _this.getCollection(type).then(
      function (c) {
        return new Promise(function (resolve) {
          c.createIndex(properties, options || {}, function () {
            resolve(c);
          });
        });
      });
  };

  /**
   * @param {String} type
   * @param {{}} properties
   * @returns {Promise}
   */
  this._ensureAutoincrement = function (type, properties) {
    var data = {};
    var steps = {};
    var act = false;
    if (properties) {
      for (var nm in properties) {
        if (properties.hasOwnProperty(nm)) {
          data[nm] = 0;
          steps[nm] = properties[nm];
          act = true;
        }
      }

      if (act) {
        return new Promise(function (resolve, reject) {
          _this.getCollection(AUTOINC_COLLECTION).then(
            function (c) {
              c.findOne({type: type}, function (err, r) {
                if (err) {
                  return reject(err);
                }

                if (r && r.counters) {
                  for (var nm in r.counters) {
                    if (r.counters.hasOwnProperty(nm) && data.hasOwnProperty(nm)) {
                      data[nm] = r.counters[nm];
                    }
                  }
                }

                c.updateOne(
                  {type: type},
                  {$set: {counters: data, steps: steps}},
                  {upsert: true},
                  function (err) {
                    if (err) {
                      return reject(err);
                    }
                    resolve();
                  }
                );
              });
            }
          ).catch(reject);
        });
      }
    }
    return new Promise(function (resolve) { resolve(); });
  };
}

// Util.inherits(MongoDs, DataSource); //jscs:ignore requireSpaceAfterLineComment

MongoDs.prototype = new DataSource();

module.exports = MongoDs;
