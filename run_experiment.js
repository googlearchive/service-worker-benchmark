/*
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Chrome expires Service Workers on a 30 second timer, so the expiration time
 * is on average every 45.
 *
 * @const
 */
var SERVICE_WORKER_LIFETIME = 45;

/**
 * Chrome crashes the renderer when too many Service Workers are active in a
 * single renderer (due to an OoM condition).
 *
 * @const
 */
var MAX_WORKERS = 5;

/**
 * To ensure that we never have more than +MAX_WORKERS+ Service Workers active
 * at the same time, we ensure that we only create a new Service Worker at the
 * rate Service Workers are currently expiring.
 *
 * @const
 */
var SERVICE_WORKERS_PER_SECOND = MAX_WORKERS / SERVICE_WORKER_LIFETIME;

/**
 * Configures how many requests to make to the Service Worker. If you update
 * this value, be sure to also update the HTML file.
 *
 * @const
 */
var DEFAULT_REQUEST_COUNTS = [0, 200];

/**
 * Configures which percentiles are displayed in the table. If you update this
 * value, be sure to also update the HTML file.
 *
 * @const
 */
var DEFAULT_PERCENTILES = [50, 90];

/**
 * Configures the number of times to repeat each trial.
 */
var NUMBER_OF_TRIALS = 5;

/** @enum {string} */
var RequestType = {
  IMAGE: 'IMAGE',
  STYLESHEET: 'STYLESHEET',
  SCRIPT: 'SCRIPT',
  XHR: 'XHR',
  FETCH: 'FETCH'
};

/** @enum {string} */
var ServiceWorkerType = {
  NONE: 'NONE',
  EMPTY: 'EMPTY',
  FALLTHROUGH: 'FALLTHROUGH',
  RESPOND_WITH_FETCH: 'RESPOND_WITH_FETCH',
  CACHE_MISS: 'CACHE_MISS',
  CACHE_HIT: 'CACHE_HIT',
  NEW_RESPONSE: 'NEW_RESPONSE',
  RESPOND_WITH_FAST: 'RESPOND_WITH_FAST'
};

/**
 * @typedef {{requestType: RequestType,
 *            requestCount: number,
 *            requestPrefix: number,
 *            concurrency: number,
 *            serviceWorkerType: ServiceWorkerType,
 *            minimumTime: number,
 *            registerBefore: boolean,
 *            unregisterAfter: boolean,
 *            isMeasurement: boolean}}
 */
var Trial;

/**
 * @typedef {{pageLoadTimeInMs: number,
 *            resourceLoadTimes: Array.<number>}}
 */
var TrialResult;

/**
 * @dict
 * @type {Object.<ServiceWorkerType, string>}
 */
var WORKER_PATH = {};
WORKER_PATH[ServiceWorkerType.NONE] = '';
WORKER_PATH[ServiceWorkerType.EMPTY] = '_empty.js';
WORKER_PATH[ServiceWorkerType.FALLTHROUGH] = '_fallthrough.js';
WORKER_PATH[ServiceWorkerType.RESPOND_WITH_FETCH] = '_respond_with_fetch.js';
WORKER_PATH[ServiceWorkerType.CACHE_MISS] = '_cache_miss.js';
WORKER_PATH[ServiceWorkerType.CACHE_HIT] = '_cache_hit.js';
WORKER_PATH[ServiceWorkerType.NEW_RESPONSE] = '_new_response.js';
WORKER_PATH[ServiceWorkerType.RESPOND_WITH_FAST] =
  '_respond_with_fast_fetch.js';

/**
 * A PromisePool invokes a series of Promisified functions, ensuring that only
 * +size+ of them are running at a time.
 *
 * Note that +size+ must be at least one.
 *
 * @constructor
 * @param {number} size How many things to run at the same time.
 */
var PromisePool = function(size) {
  if (size <= 0)
    throw new Error('Pool size must be at least one');
  this.size_ = size;
  this.active_ = 0;
  this.backlog_ = [];
};

/**
 * Asynchronously evaluates the given +task+ Promise factory in this
 * PromisePool.
 *
 * @this
 * @param {function (): Promise} task The function to invoke.
 * @return {Promise}
 */
PromisePool.prototype.add = function(task) {
  return new Promise(function(resolve, reject) {
    if (this.active_ < this.size_) {
      var schedule = function() {
        this.active_--;
        var next = this.backlog_.shift();
        if (next)
          this.add(next);
      }.bind(this);

      this.active_++;
      Promise.resolve(task()).then(resolve, reject).then(schedule, schedule);
    } else {
      this.backlog_.push(function() {
        return Promise.resolve(task()).then(resolve, reject);
      });
    }
  }.bind(this));
};

/**
 * Asynchronously schedules an array of promises in this PromisePool.
 *
 * @param {Array.<function(): Promise>} tasks What to invoke.
 * @return {Promise}
 */
PromisePool.prototype.addAll = function(tasks) {
  return Promise.all(tasks.map(this.add.bind(this)));
};

/**
 * Adds a scheduling fence, returning a promise when all promises before
 * this one have been resolved.
 *
 * For example, if we have a pool of size two, with tasks inserted as follows,
 *
 *   p = new PromisePool(2);  //
 *   X = p.add(x)             // xxxxxxx
 *   Y = p.add(y)             // yy
 *   Z = p.add(z)             //   zz
 *   D = p.drain()            //
 *   W = p.add(w)             //        wwwwww
 *
 * then D resolves after X finishes but before w() starts.
 *
 * @return {Promise}
 */
PromisePool.prototype.drain = function() {
  // Internally, this code adds +size+ tasks, saving them into the pool, each
  // of which blocks until all have completed. At that point all are removed,
  // and the promise is resolved.
  var promise = new Promise(function(resolve, reject) {
    var timesStarted = 0;

    for (var i = 0; i < this.size_; i++) {
      this.add(function() {
        timesStarted++;
        if (timesStarted == this.size_)
          resolve();
        return promise;
      }.bind(this));
    }
  }.bind(this));

  return promise;
};

/**
 * Formats a Trial as human-readable text.
 *
 * @param {Trial} trial Which trial to describe.
 * @return {string}
 */
var describeTrial = function(trial) {
  return ('(requestType=' + trial.requestType + ', serviceWorkerType=' +
          trial.serviceWorkerType + ', requestCount=' + trial.requestCount +
          ', concurrency=' + trial.concurrency + ')');
};

/**
 * Runs a promisified XHR to the given path.
 *
 * @param {string} url Where to fetch the given request.
 * @return {Promise}
 */
var sendXHR = function(url) {
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest;
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function() {
      if (xhr.readyState != 4)
        return;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText);
      } else {
        reject('XMLHttpRequest to ' + url + ' failed: #' + xhr.status);
      }
    };
    xhr.send();
  });
};

/**
 * Loads an image from the given path.
 *
 * @param {string} url Where to fetch the image from.
 * @return {Promise}
 */
var sendImageRequest = function(url) {
  return new Promise(function(resolve, reject) {
    var imageTag = document.createElement('img');
    imageTag.onload = resolve;
    // TODO: _new_response.js generates invalid image.
    imageTag.onerror = resolve;
    imageTag.src = url;
    document.documentElement.appendChild(imageTag);
  });
};

/**
 * Loads a stylesheet from the given path.
 *
 * @param {string} url Where to fetch the stylesheet from.
 * @return {Promise}
 */
var sendStylesheetRequest = function(url) {
  return new Promise(function(resolve, reject) {
    var linkTag = document.createElement('link');
    linkTag.rel = 'stylesheet';
    linkTag.onload = resolve;
    linkTag.onerror = reject;
    linkTag.href = url;
    document.documentElement.appendChild(linkTag);
  });
};

/**
 * Loads a script from the given path.
 *
 * @param {string} url Where to fetch the script from.
 * @return {Promise}
 */
var sendScriptRequest = function(url) {
  return new Promise(function(resolve, reject) {
    var scriptTag = document.createElement('script');
    scriptTag.onload = resolve;
    scriptTag.onerror = reject;
    scriptTag.src = url;
    document.documentElement.appendChild(scriptTag);
  });
};

/**
 * Loads a given page as an iframe, returning a promise.
 *
 * Note that the page must call window.top._resolveIframePromise if it
 * wants the Promise to resolve, and window.top._rejectIframePromise if
 * it wants the Promise to reject. Otherwise, the Promise will hang
 * indefinitely.
 *
 * @param {string} url What URL to load.
 * @return {Promise}
 */
var loadPageInIframe = function(url) {
  return new Promise(function(resolve, reject) {
    if (window._resolveIframePromise || window._rejectIframePromise)
      throw new Error('only one <iframe> can be active at a time');

    window._resolveIframePromise = function(result) {
      iframe.remove();
      resolve(result);
      window._resolveIframePromise = window._rejectIframePromise = null;
    };

    window._rejectIframePromise = function(failure) {
      iframe.remove();
      reject(failure);
      window._resolveIframePromise = window._rejectIframePromise = null;
    };

    var iframe = document.createElement('iframe');
    iframe.src = url;
    document.documentElement.appendChild(iframe);
  });
};

/**
 * Gets the name of the directory containing window.top.
 *
 * @return {string} The base path of this application.
 */
var getDirnameOfWindowTop = function() {
  return window.top.location.href.replace(/\/[^\/]*$/, '') + '/';
};

/**
 * Performs the given benchmark and saves the result.
 *
 * @param {Request} trial What benchmark to perform.
 */
var runTrial = function(trial) {
  var base = getDirnameOfWindowTop();
  var pool = new PromisePool(trial.concurrency);
  var resourceLoadTimes = [];

  for (var i = 0; i < trial.requestCount; i++) {
    var suffix = '?' + encodeURIComponent(JSON.stringify(trial)) + i;
    var task = null;

    switch (trial.requestType) {
    case RequestType.IMAGE:
      task = sendImageRequest.bind(null, base + 'image.jpg' + suffix);
      break;
    case RequestType.STYLESHEET:
      task = sendStylesheetRequest.bind(null,
                   base + 'stylesheet.css' + suffix);
      break;
    case RequestType.SCRIPT:
      task = sendScriptRequest.bind(null, base + 'script.js' + suffix);
      break;
    case RequestType.XHR:
      task = sendXHR.bind(null, base + 'xhr.txt' + suffix);
      break;
    case RequestType.FETCH:
      task = fetch.bind(null, base + 'xhr.txt' + suffix);
      break;
    }

    pool.add(function() {
      var start = performance.now();
      return task().then(function() {
        var end = performance.now();
        resourceLoadTimes.push(end - start);
      });
    });
  }

  var start = performance.now();
  pool.drain().then(function() {
    var finish = performance.now();
    var trialResult = {
      pageLoadTimeInMs: finish - start + window.timeToLoadHTMLInMs,
      resourceLoadTimes: resourceLoadTimes
    };
    console.log(describeTrial(trial), trialResult.pageLoadTimeInMs, 'ms');
    window.top._resolveIframePromise(trialResult);
  });
};

/**
 * Saves the load time for the current page as a benchmark result.
 *
 * @param {Trial} trial What trial to update and save.
 */
var runFullPageTrial = function(trial) {
  var trialResult = {
    pageLoadTimeInMs: window._loadEventStart - window.top._registerStart,
    resourceLoadTimes: []
  };
  console.log(describeTrial(trial), trialResult.pageLoadTimeInMs, 'ms');
  window.top._resolveIframePromise(trialResult);
};

/**
 * Shuffles this array using the Fisher-Yates-Knuth shuffle.
 *
 * (from http://stackoverflow.com/a/12646864)
 *
 * @param {Array} array Which array to shuffle.
 */
var shuffleArray = function(array) {
  for (var i = array.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
};

/**
 * Registers a ServiceWorker, waiting for it to activate.
 *
 * @param {string} scope What scope to use for the Worker.
 * @param {string} scriptURL What JavaScript to run in the worker.
 * @return {Promise}
 */
var registerWorkerAndWait = function(scope, scriptURL) {
  return navigator.serviceWorker.register(scriptURL, {scope: scope})
      .then(function(reg) {
    return new Promise(function(resolve, reject) {
      var worker = reg.installing || reg.waiting || reg.active;
      if (worker.state == 'activated') {
        resolve(worker);
      } else {
        worker.onstatechange = function() {
          if (worker.state == 'activated')
            resolve(worker);
        };
      }
    });
  });
};

/**
 * Runs a benchmark with the given parameters.
 *
 * @param {Trial} trial What benchmark to run.
 * @return {Promise}
 */
var runTrialInFrame = function(trial) {
  var scriptURL = getDirnameOfWindowTop() +
                  WORKER_PATH[trial.serviceWorkerType];
  var generatedPrefix = 'scopes/' + trial.requestPrefix;

  var iframeSrc;
  if (trial.concurrency > 0) {
    iframeSrc = generatedPrefix + '/run_trial.html';
  } else {
    if ([RequestType.XHR, RequestType.FETCH].indexOf(trial.requestType) >= 0)
      throw new Error('Cannot use static page with ' + trial.requestType);
    iframeSrc = generatedPrefix + '/static_pages/' + trial.requestType + '_' +
                trial.requestCount + '.html';
  }

  window.top._registerStart = new Date().getTime();

  var state = Promise.resolve(null);
  if (trial.registerBefore) {
    if (trial.serviceWorkerType != ServiceWorkerType.NONE) {
      state = registerWorkerAndWait(iframeSrc, scriptURL);
    } else {
      var url = getDirnameOfWindowTop() + WORKER_PATH[ServiceWorkerType.EMPTY];
      state = fetch(url);
    }
  }

  state = state.then(function() {
    var slug = encodeURIComponent(JSON.stringify(trial));
    return loadPageInIframe(iframeSrc + '#' + slug);
  });

  if (trial.unregisterAfter &&
      trial.serviceWorkerType != ServiceWorkerType.NONE) {
    state = state.then(function(trialResult) {
      var promise = navigator.serviceWorker.getRegistration(iframeSrc);
      return promise.then(function(registration) {
        // Calling unregister() only starts the unregistration process, so
        // we need to poll getRegistration to be certain that the worker is
        // gone. 
        var wait_for_actually_unregistered = function() {
          var regPromise = navigator.serviceWorker.getRegistration(iframeSrc);
          return regPromise.then(function(reg) {
            if (reg)
              return sleep(300).then(wait_for_actually_unregistered);
          });
        };
        return registration.unregister().then(wait_for_actually_unregistered);
      }).then(function() {
        return trialResult;
      });
    });
  }

  return state;
};

/**
 * Waits the given amount of time.
 *
 * @param {number} delay How long to wait, in seconds.
 * @return {Promise}
 */
var sleep = function(delay) {
  return new Promise(function(resolve, reject) {
    setTimeout(resolve, delay * 1000);
  });
};

/**
 * Runs the given experiment.
 *
 * @param {Array.<Trial>} experiment What trials to run.
 * @param {?function(number, Trial)} reportProgress How to display progress.
 * @return {Promise} A callback for completion.
 */
var runExperiment = function(trials, reportProgress) {
  var queue = new PromisePool(1);
  var results = [];

  for (var i = 0; i < trials.length; i++) {
    queue.add(function(i, _) {
      if (reportProgress)
        reportProgress(i, trials[i]);
      return Promise.all([
        runTrialInFrame(trials[i]).then(function(trial) {
          results.push(trial);
        }),
        sleep(trials[i].minimumTime)
      ]);
    }.bind(null, i));
  }

  return queue.drain().then(function() {
    if (reportProgress)
      reportProgress(trials.length, null);
    return results;
  });
};

/**
 * Computes the given percentile value from the given array.
 *
 * @param {Array.<number>} array Source data.
 * @param {number} fraction What percentile to return.
 * @return {number} The value at that percentile.
 */
var percentile = function(array, fraction) {
  var copy = array.slice();
  copy.sort(function(a, b) { return a < b ? -1 : 1 });
  return copy[Math.round((copy.length - 1) * fraction)];
};

/**
 * Puts the given measurement into the element with the given ID.
 * If this measurement is relative, the element is styled appropriately.
 *
 * @param {string} id Where to put this measurement.
 * @param {number} measurement The value of this measurement.
 * @param {?boolean} isRelative Whether to style this number as a difference.
 */
var displayResult = function(id, measurement, isRelative) {
  var elem = document.getElementById(id);
  var rounded = Math.round(measurement);
  if (isRelative) {
    elem.textContent = (
      (measurement > 0 ? '+' : '') + Math.round(measurement * 100) + '%');
    if (measurement < 0)
      elem.style.color = '#390';
    else if (measurement > 0)
      elem.style.color = '#a00';
  } else {
    elem.textContent = Math.round(rounded);
  }
};

/**
 * Runs the Service Worker Benchmark.
 */
var startExperiment = function() {
  var experiment = [];
  var counts = DEFAULT_REQUEST_COUNTS;
  var percentiles = DEFAULT_PERCENTILES;

  // Vary number of resources and worker type.
  var trialIndex = 0;
  for (var i = 0; i < counts.length; i++) {
    for (var type in ServiceWorkerType) {
      for (var j = 0; j < NUMBER_OF_TRIALS; j++) {
        experiment.push({
          requestType: RequestType.IMAGE,
          requestCount: counts[i],
          requestPrefix: trialIndex++,
          serviceWorkerType: type,
          concurrency: 0,
          registerBefore: true,
          unregisterAfter: true,
          isMeasurement: true,
          minimumTime: 1 / SERVICE_WORKERS_PER_SECOND
        });
      }
    }
  }

  shuffleArray(experiment);

  runExperiment(experiment).then(function(results) {
    // Aggregate data across all trials.
    var metrics = {};
    for (var i = 0; i < counts.length; i++) {
      for (var type in ServiceWorkerType)
        metrics[type + '_' + counts[i]] = [];
    }

    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      var trial = experiment[i];
      metrics[trial.serviceWorkerType + '_' + trial.requestCount].push(
        result.pageLoadTimeInMs);
    }

    // Display the result as a table.
    for (var i = 0; i < counts.length; i++) {
      for (var type in ServiceWorkerType) {
        for (var p = 0; p < percentiles.length; p++) {
          var pct = percentiles[p];
          var value = percentile(metrics[type + '_' + counts[i]], pct / 100);
          var base =  percentile(metrics['NONE_' + counts[i]], pct / 100);

          displayResult(
            'p' + pct + '-' + type.toLowerCase() + '-' + counts[i],
            value);

          if (type != ServiceWorkerType.NONE) {
            displayResult(
              'p' + pct + '-rel-' + type.toLowerCase() + '-' + counts[i],
              (value - base) / base, true);
          }
        }
      }
    }
    return metrics;
  });
};
