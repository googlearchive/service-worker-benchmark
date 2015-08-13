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

/** @typedef {{requestType: RequestType,
 *             serviceWorkerType: ServiceWorkerType,
 *             count: number,
 *             concurrency: number,
 *             minimumTime: number,
 *             totalLoadTime: ?number,
 *             registerBefore: boolean,
 *             unregisterAfter: boolean,
 *             isMeasurement: boolean}} */
var Trial;

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
 * @constructor
 * @param {number} size How many things to run at the same time.
 */
var PromisePool = function(size) {
  this.size_ = size;
  this.active_ = 0;
  this.backlog_ = [];
};

/**
 * Asynchronously evaluates the given +thenable+ Promise factory in this
 * PromisePool.
 *
 * @this
 * @param {function (): Promise} thenable The function to invoke.
 * @return {Promise}
 */
PromisePool.prototype.add = function(thenable) {
  return new Promise(function(resolve, reject) {
    if (this.active_ < this.size_) {
      var schedule = function() {
        this.active_--;
        var next = this.backlog_.shift();
        if (next)
          this.add(next);
      }.bind(this);

      this.active_++;
      var task = Promise.resolve(thenable());
      task.then(resolve, reject).then(schedule, schedule);
    } else {
      this.backlog_.push(function() {
        return thenable().then(resolve, reject);
      });
    }
  }.bind(this));
};

/**
 * Asynchronously schedules an array of promises in this PromisePool.
 *
 * @param {Array.<function(): Promise>} thenables What to invoke.
 * @return {Promise}
 */
PromisePool.prototype.addAll = function(thenables) {
  return Promise.all(thenables.map(this.add.bind(this)));
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
    imageTag.src = url;
    imageTag.onload = resolve;
    imageTag.onerror = reject;
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
    linkTag.href = url;
    linkTag.rel = 'stylesheet';
    linkTag.onload = resolve;
    linkTag.onerror = reject;
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
    scriptTag.src = url;
    scriptTag.onload = resolve;
    scriptTag.onerror = reject;
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
      throw new Error("only one <iframe> can be active at a time");

    window._resolveIframePromise = function(result) {
      iframe.parentNode.removeChild(iframe);
      resolve(result);
      window._resolveIframePromise = window._rejectIframePromise = null;
    };

    window._rejectIframePromise = function(failure) {
      iframe.parentNode.removeChild(iframe);
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
 * Reports the time required to complete the given task.
 *
 * @param {string} key Which histogram to record this value for.
 * @param {function(): Promise} thenable What task to run.
 * @return {function(): Promise} A transformed thenable.
 */
var recordRuntime = function(key, thenable) {
  return function() {
    var start = performance.now();
    var record = function(passedValue) {
      var finish = performance.now();
      var histogram = 'histogram_' + key;
      var histogramJSON;

      try {
        histogramJSON = JSON.parse(localStorage[histogram]);
      } catch (e) {
        histogramJSON = {};
      }

      var bucket = Math.floor(finish - start);
      histogramJSON[bucket] = (histogramJSON[bucket] || 0) + 1;
      localStorage[histogram] = JSON.stringify(histogramJSON);

      return passedValue;
    };
    return thenable().then(record, record);
  };
};

/**
 * Performs the given benchmark and saves the result.
 *
 * @param {Request} trial What benchmark to perform.
 */
var runTrial = function(trial) {
  var base = getDirnameOfWindowTop();
  var pool = new PromisePool(trial.concurrency);

  for (var i = 0; i < trial.count; i++) {
    var suffix = '?' + encodeURIComponent(JSON.stringify(trial)) + i;
    var thenable = null;

    switch (trial.requestType) {
    case RequestType.IMAGE:
      thenable = sendImageRequest.bind(null, base + 'image.jpg' + suffix);
      break;
    case RequestType.STYLESHEET:
      thenable = sendStylesheetRequest.bind(null,
                   base + 'stylesheet.css' + suffix);
      break;
    case RequestType.SCRIPT:
      thenable = sendScriptRequest.bind(null, base + 'script.js' + suffix);
      break;
    case RequestType.XHR:
      thenable = sendXHR.bind(null, base + 'xhr.txt' + suffix);
      break;
    case RequestType.FETCH:
      thenable = fetch.bind(null, base + 'xhr.txt' + suffix);
      break;
    }

    if (trial.isMeasurement)
      thenable = recordRuntime(trial.serviceWorkerType, thenable);
    pool.add(thenable);
  }

  var start = performance.now();
  pool.drain().then(function() {
    var finish = performance.now();
    var loadTime = trial.totalLoadTime =
      finish - start + window.timeToLoadHTMLInMs;

    // Save results to localStorage.
    var results = [];
    try {
      var results = JSON.parse(localStorage.getItem('results')) || [];
    } catch (e) {}
    results.push(trial);
    localStorage.setItem('results', JSON.stringify(results));

    console.log('Trial: ', describeTrial(trial), ' took ', loadTime, ' ms');

    window.top._resolveIframePromise();
  });
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
 * Runs a benchmark with the given parameters.
 *
 * @param {Trial} trial What benchmark to run.
 * @return {Promise}
 */
var runTrialInFrame = function(trial) {
  var scriptURL = getDirnameOfWindowTop() + WORKER_PATH[type];
  var iframeSrc = [
    'infinite_scopes',
    trial.serviceWorkerType,
    trial.requestType,
    trial.count
  ].join('/') + '/run_trial.html';

  var state = Promise.resolve(null);
  if (trial.registerBefore && trial.type != ServiceWorkerType.NONE)
    state = navigator.serviceWorker.register(scriptURL, {scope: iframeSrc});

  state = state.then(function() {
    var slug = encodeURIComponent(JSON.stringify(trial));
    return loadPageInIframe(iframeSrc + '#' + slug);
  });

  if (trial.unregisterAfter && trial.type != ServiceWorkerType.NONE) {
    state = state.then(function() {
      return navigator.serviceWorker.getRegistration(iframeSrc);
    }).then(function(registration) {
      return registration.unregister();
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
 * Generates (and runs) an experimental trial.
 *
 * @return {Array.<Trial>} Which trials to invoke.
 */
var generateExperiment = function() {
  var experiment = [];
  var maxCount = 200;

  for (var _serviceWorkerType in ServiceWorkerType) {
    for (var resourceCount = 0; resourceCount <= maxCount; resourceCount += 5) {
      experiment.push({
        requestType: RequestType.IMAGE,
        serviceWorkerType: ServiceWorkerType[_serviceWorkerType],
        count: resourceCount,
        concurrency: 5,
        minimumTime: 30 / 5, // at most five at a time.
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

  warmup[warmup.length - 1].minimumTime = 60; // force workers to stop

  return warmup.concat(experiment);
};

/**
 * Runs the given experiment.
 *
 * @param {Array.<Trial>} experiment What trials to run.
 * @param {?function(number, Trial)} reportProgress How to display progress.
 * @return {Promise} A callback for completion.
 */
var runExperiment = function(experiment, reportProgress) {

  // Resume the current experiment on crash.
  try {
    var trials = JSON.parse(localStorage.getItem('trials'));
  } catch (e) {}

  if (!trials || !trials.length) {
    trials = experiment;
    localStorage.setItem('results', JSON.stringify([]));
  }

  // Ensure that experiments are evaluated in order.
  var queue = new PromisePool(1);

  for (var i = 0; i < trials.length; i++) {
    queue.add(function(i, _) {

      if (reportProgress)
        reportProgress(i + (experiment.length - trials.length), trials[i]);

      var trialsToSave = trials.slice(i);
      localStorage.setItem('trials', JSON.stringify(trialsToSave));

      var trial = runTrialInFrame(trials[i]);

      return Promise.all([trial, sleep(trials[i].minimumTime)]);

    }.bind(null, i));
  }

  return queue.drain().then(function() {
    localStorage.setItem('trials', JSON.stringify([]));
    if (reportProgress)
      reportProgress(experiment.length, null);
    return JSON.parse(localStorage.getItem('results'));
  });
};

/**
 * Starts running an experiment on the current page.
 */
var startExperiment = function() {
  var experiment = generateExperiment();
  var progressBar = document.getElementsByTagName('progress')[0];
  var resultsSpan = document.getElementById('results');

  // TODO(jeremyarcher): the below gives incorrect estimates on reload.
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

  }).then(function(results) {

    // Group the results by count and worker type.
    var rows = {};
    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      if (result.isMeasurement)
        continue;
      var row = rows[result.count] = rows[result.count] || {};
      row[result.serviceWorkerType] = Math.min(
        row[result.serviceWorkerType] || Infinity,
        result.totalLoadTime
      );
    }

    // Generate a TSV table that is copyable into Docs.
    var buf = [
      'Count', 'None', 'Empty', 'Fallthrough', 'Respond With Fetch',
      'Cache Miss', 'Cache Hit', 'New Response', 'Respond With (Fast)'
    ].join('\t') + '\n';

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

    // Print out histogram information for each type of Service Worker.
    var buf = [
      'Latency (ms)', 'None', 'Empty', 'Fallthrough', 'Respond With Fetch',
      'Cache Miss', 'Cache Hit', 'New Response', 'Respond With (Fast)'
    ].join('\t') + '\n';

    var histograms = {};
    var upperBound = 0;
    for (var label in ServiceWorkerType) {
      var idx = ServiceWorkerType[label];
      histograms[label] = JSON.parse(localStorage['histogram_' + idx]);
      for (var key in histograms[label])
        upperBound = Math.max(upperBound, parseInt(key, 10));
    }

    for (var i = 0; i <= upperBound; i++) {
      var any = false;
      var row = [i];
      for (var label in ServiceWorkerType) {
        var idx = ServiceWorkerType[label];
        row[idx - ServiceWorkerType.NONE + 1] = histograms[label][i] || 0;
      }
      buf += row.join('\t') + '\n';
    }

    console.log(buf);
  });
};
