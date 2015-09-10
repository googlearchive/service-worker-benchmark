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
 * This function monkey patches the given onfetch handler, dynamically
 * converting respondWith(fetch(...)) into fallback responses.
 *
 * @param {function(Event)} fetchHandler How to handle fetch events.
 * @return {function(Event)} A modified, optimized fetch event handler.
 */
var optimizeFetch = function(fetchHandler) {
  // Track which request fired each Promise.
  var requests = new WeakMap;

  if (!self._fetchWasPatched) {
    self._fetchWasPatched = true;
    var _fetch = self.fetch;
    self.fetch = function(req) {
      var p = _fetch(req);
      requests.set(p, req);
      return p;
    };
  }

  // Avoid calling respondWith(...) on Promises that are equivalent to
  // a fallback response.
  return function(event) {
    var _respondWith = event.respondWith.bind(event);
    event.respondWith = function(promise) {
      if (requests.get(promise) != event.request)
        return _respondWith(promise);
    };
    return fetchHandler(event);
  };
};

addEventListener('fetch', optimizeFetch(function(event) {
  event.respondWith(fetch(event.request));
}));
