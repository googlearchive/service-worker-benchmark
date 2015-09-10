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
# This script generates 1,000 scopes, each containing symlinks to files in the
# root. Because of a Github Pages symlink bug, we cannot simply have each
# directory map back to its parent, as would be the more obvious approach.

rm -Rf scopes

mkdir -p scopes
seq 0 999 | xargs "-I{}" ln -s next_step "scopes/{}"

mkdir -p scopes/next_step
ln -s ../../run_trial.html scopes/next_step/run_trial.html
ln -s ../../static_pages scopes/next_step/static_pages

if ! [ -f scopes/42/run_trial.html ]; then
  echo "Self-test failed: unable to resolve scopes/42/run_trial.html"
  exit 1
fi

