#!/bin/bash -e
#
# Copyright 2015 Google Inc. All Rights Reserved.

# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
# 
#     http://www.apache.org/licenses/LICENSE-2.0
# 
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
#

rm -rf static_pages/
mkdir -p static_pages/

REQUEST_TYPES="IMAGE STYLESHEET SCRIPT"

# Include assets in static_pages directory to fix problems with symlinks.
cp image.jpg stylesheet.css script.js static_pages/

# Generate {REQUEST_TYPE}_0.html
for REQUEST_TYPE in $REQUEST_TYPES; do
  touch static_pages/"$REQUEST_TYPE"_0.html
done

# Generate {REQUEST_TYPE}_{COUNT}.html
#
# Note: when changing the number of requests, also change the value in
# run_experiment.js.
for i in $(seq 1 200); do
  for REQUEST_TYPE in $REQUEST_TYPES; do
    cp static_pages/"$REQUEST_TYPE"_$(($i-1)).html \
       static_pages/"$REQUEST_TYPE"_$i.html
  done

  echo "<img src='image.jpg?$i'/>" \
    >> static_pages/IMAGE_$i.html
  echo "<link rel='stylesheet' href='stylesheet.css?$i'/>" \
    >> static_pages/STYLESHEET_$i.html
  echo "<script src='script.js?$i'></script>" \
    >> static_pages/SCRIPT_$i.html
done

# Patch generated HTML to add measurement code.
for file in $(find static_pages -name '*.html'); do
  cat >>$file <<EOF
<script type='text/javascript'>
  window.onload = function() {
    var myURL = window.location.href;
    var dirname = myURL.replace(/(infinite_scopes\/.*\/)?[^/]+$/, '');
    var path = dirname + '../run_experiment.js';
    var script = document.createElement('script');
    script.src = path;
    document.documentElement.appendChild(script);
    script.onload = function() {
      var hash = window.location.hash.substring(1);
      runFullPageTrial(JSON.parse(decodeURIComponent(hash)));
    };
  };
</script>
EOF
done
