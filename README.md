Service Worker Benchmarks
=========================

Current versions of Chrome/Blink support Service Workers, a web platform
standard that enables application authors to provide rich offline and mobile
experiences. These benchmarks measure the latency penalty required in order to
deliver these additional features, and help make the web faster.

How do I use this code?
-----------------------

To run a benchmark, clone the repository and serve it locally over HTTP:

    % git clone git@github.com:chromium/service-worker-benchmarks.git
    % cd service-worker-benchmarks/
    % ./generate_infinite_scopes.sh
    % python -mSimpleHTTPServer :1337

and then open http://localhost:1337 in a browser. By default, the benchmark
tests the time to load 100 images under five different scenarios. These
correspond to cases where a Service Worker:

1. is empty;
2. does not call `respondWith`;
3. calls `respondWith(fetch(...))`;
4. uses `caches.match(...)` (both hits and misses); or
5. constructs a local synthetic response;

as well as a control case with no Service Worker. These values are printed in
TSV format to the web console.

What can be measured with this tool?
------------------------------------

Natively, this software supports varying:

1. the number of requests;
2. the concurrency of requests to the worker;
3. the fetch path (which element or function is triggering the request); and
4. the size of the response;

as well as the Service Worker being tested. The code also generates a request
latency distribution, allowing more granular testing of tail latency.

Does this test only work in Chrome?
------------------------------------

The code was written to use Google Chrome M45+, but tracks the behavior of the
spec (it uses no internal or vendor-specific APIs). As a result, it should be
possible to generate data for other browsers once the respective features ship.
