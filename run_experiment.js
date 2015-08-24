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
 * Defines the default range of resource counts to sample.
 *
 * Note: when changing this value, also update the equivalent constant in the
 * generate_static_pages.sh script.
 *
 * @const
 */
var DEFAULT_RESOURCE_COUNTS = [];
for (var i = 0; i < 200; i += 5) {
  DEFAULT_RESOURCE_COUNTS.push(i);
}

/** @enum */
var RequestType = {
  IMAGE: 1,
  STYLESHEET: 2,
  SCRIPT: 3,
  XHR: 4,
  FETCH: 5
};

/** @enum */
var ServiceWorkerType = {
  NONE: 1,
  EMPTY: 2,
  FALLTHROUGH: 3,
  RESPOND_WITH_FETCH: 4,
  CACHE_MISS: 5,
  CACHE_HIT: 6,
  NEW_RESPONSE: 7,
  RESPOND_WITH_FAST: 8
};

/**
 * @typedef {{requestType: RequestType,
 *            serviceWorkerType: ServiceWorkerType,
 *            count: number,
 *            concurrency: number,
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
        if (timesStarted == this.size_) {
          resolve();
        }
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
  var requestType = '';
  for (var k in RequestType) {
    if (RequestType[k] == trial.requestType)
      requestType = k;
  }

  var serviceWorkerType = '';
  for (var k in ServiceWorkerType) {
    if (ServiceWorkerType[k] == trial.serviceWorkerType)
      serviceWorkerType = k;
  }

  return ('(requestType=' + requestType + ', serviceWorkerType=' +
          serviceWorkerType + ', count=' + trial.count + ', concurrency=' +
          trial.concurrency + ')');
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
      if (xhr.readyState != 4) {
        return;
      }
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

  for (var i = 0; i < trial.count; i++) {
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
    pageLoadTimeInMs: performance.timing.loadEventStart -
                      performance.timing.navigationStart,
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
  var generatedPrefix = [
    'infinite_scopes',
    trial.serviceWorkerType,
    trial.requestType,
    trial.count
  ].join('/');

  var iframeSrc;
  if (trial.concurrency > 0) {
    iframeSrc = generatedPrefix + '/run_trial.html';
  } else {
    var resourceType;
    for (var _requestType in RequestType) {
      if (RequestType[_requestType] == trial.requestType)
        resourceType = _requestType;
    }
    if ([RequestType.XHR, RequestType.FETCH].indexOf(trial.requestType) >= 0)
      throw new Error("Cannot use static page with " + resourceType);
    iframeSrc = generatedPrefix + '/static_pages/' + resourceType + '_' +
                trial.count + '.html';
  }

  var state = Promise.resolve(null);
  if (trial.registerBefore && trial.serviceWorkerType != ServiceWorkerType.NONE)
    state = registerWorkerAndWait(iframeSrc, scriptURL);

  state = state.then(function() {
    var slug = encodeURIComponent(JSON.stringify(trial));
    return loadPageInIframe(iframeSrc + '#' + slug);
  });

  if (trial.unregisterAfter &&
      trial.serviceWorkerType != ServiceWorkerType.NONE) {
    state = state.then(function(trialResult) {
      var promise = navigator.serviceWorker.getRegistration(iframeSrc);
      return promise.then(function(registration) {
        return registration.unregister();
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
 * Generates an experimental trial.
 *
 * @return {Array.<Trial>} Which trials to invoke.
 */
var generateExperiment = function() {
  var experiment = [];

  for (var _serviceWorkerType in ServiceWorkerType) {
    for (var i = 0; i < DEFAULT_RESOURCE_COUNTS.length; i++) {
      experiment.push({
        requestType: RequestType.IMAGE,
        serviceWorkerType: ServiceWorkerType[_serviceWorkerType],
        count: DEFAULT_RESOURCE_COUNTS[i],
        concurrency: 0, // Use a static file instead of DOM insertion.
        minimumTime: 1 / SERVICE_WORKERS_PER_SECOND,
        registerBefore: false,
        unregisterAfter: true,
        isMeasurement: true
      });
    }
  }

  shuffleArray(experiment);

  var warmup = [];

  for (var i = 0; i < experiment.length; i++) {
    var trial = JSON.parse(JSON.stringify(experiment[i]));
    trial.registerBefore = true;
    trial.unregisterAfter = false;
    trial.isMeasurement = false;
    warmup.push(trial);
  }

  warmup[warmup.length - 1].minimumTime = SERVICE_WORKER_LIFETIME * 2;

  return warmup.concat(experiment);
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
 * Starts running an experiment on the current page.
 */
var startExperiment = function() {
  var experiment = generateExperiment();
  var progressBar = document.getElementsByTagName('progress')[0];
  var resultsSpan = document.getElementById('results');
  var startTime = new Date().getTime();

  runExperiment(experiment, function(trialIndex, trial) {
    progressBar.value = trialIndex / experiment.length;

    // Show approximately how much time remains.
    if (!trial) {
      resultsSpan.textContent = 'Complete!';
    } else {
      var timeElapsedInS = (new Date().getTime() - startTime) / 1000;
      var totalTimeInS = timeElapsedInS / progressBar.value;
      var remainingTimeInS = totalTimeInS * (1 - progressBar.value);

      resultsSpan.textContent = (progressBar.value * 100).toFixed(1) +
          '% ETA ' + (remainingTimeInS / 60).toFixed(1) + 'm';
    }
  }).then(function(trialResults) {
    // Group the results by count and worker type.
    var rows = {};
    var histograms = {};
    var histogramMax = 0;
    for (var i = 0; i < results.length; i++) {
      var trial = experiment[i];
      var result = results[i];
      if (trial.isMeasurement)
        continue;

      var row = rows[trial.count] = rows[trial.count] || {};
      row[trial.serviceWorkerType] = Math.min(
        row[trial.serviceWorkerType] || Infinity,
        result.pageLoadTime
      );

      var histogram = histograms[trial.serviceWorkerType];
      if (!histogram)
        histogram = histograms[trial.serviceWorkerType] = {};
      for (var i = 0; i < trial.resourceLoadTimes.length; i++) {
        var loadTime = Math.round(trial.resourceLoadTimes[i]);
        histogram[loadTime] = (histogram[loadTime] || 0) + 1;
        histogramMax = Math.max(histogramMax, loadTime);
      }
    }

    var headers = [
      'None', 'Empty', 'Fallthrough', 'Respond With Fetch',
      'Cache Miss', 'Cache Hit', 'New Response', 'Respond With (Fast)'
    ];

    // Generate a TSV table that is copyable into Docs.
    var buf = 'Resource Count\t' + headers.join('\t') + '\n';
    var counts = Object.keys(rows);
    counts.sort(function(a, b) { return a - b });
    for (var i = 0; i < counts.length; i++) {
      var count = counts[i];
      var row = rows[count];
      var rowAsArray = [count];
      for (var label in ServiceWorkerType) {
        var idx = ServiceWorkerType[label];
        rowAsArray[idx - ServiceWorkerType.NONE + 1] = row[idx];
      }
      buf += rowAsArray.join('\t') + '\n';
    }
    console.log(buf);

    // Generate a millisecond-quantized histogram of latency data.
    var buf = 'Load Time (ms)\t' + headers.join('\t') + '\n';
    for (var i = 0; i <= histogramMax; i++) {
      var rowAsArray = [i];
      for (var _serviceWorkerType in ServiceWorkerType) {
        var idx = ServiceWorkerType[label];
        rowAsArray[idx - ServiceWorkerType.NONE + 1] = histograms[idx][i];
      }
      buf += rowAsArray.join('\t') + '\n';
    }
    if (histogramMax == 0) {
      console.log('There are no histograms available (this might be because ' +
                  'concurrency is zero for all trials).');
    } else {
      console.log(buf);
    }

    // TODO: Add computation and display of histogram data.
  });
};
