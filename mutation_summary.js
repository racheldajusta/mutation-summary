// Copyright 2011 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

(function(global) {

  "use strict";

  // NodeMap UtilityClass. Exposed as MutationSummary.NodeMap.
  // TODO(rafaelw): Consider using Harmony Map when available.

  var ID_PROP = '__mutation-summary_node-map-id__';
  var nextId_ = 1;

  function ensureId(node) {
    if (!node[ID_PROP]) {
      node[ID_PROP] = nextId_++;
      return true;
    }

    return false;
  }

  function NodeMap() {
    this.map_ = {};
  };

  NodeMap.prototype = {
    set: function(node, value) {
      ensureId(node);
      this.map_[node[ID_PROP]] = {k: node, v: value};
    },
    get: function(node) {
      if (ensureId(node))
        return;
      var byId = this.map_[node[ID_PROP]];
      if (byId)
        return byId.v;
    },
    has: function(node) {
      return !ensureId(node) && node[ID_PROP] in this.map_;
    },
    'delete': function(node) {
      if (ensureId(node))
        return;
      delete this.map_[node[ID_PROP]];
    },
    keys: function() {
      var nodes = [];
      for (var id in this.map_) {
        nodes.push(this.map_[id].k);
      }
      return nodes;
    }
  };

  function hasOwnProperty(obj, propName) {
    return Object.prototype.hasOwnProperty.call(obj, propName);
  }

  // Reachability & Matchability changeType constants.
  var STAYED_OUT = 0;
  var ENTERED = 1;
  var STAYED_IN = 2;
  var EXITED = 3;

  // Sub-states of STAYED_IN
  var REPARENTED = 4;
  var REORDERED = 5;

  /**
   * This is no longer in use, but conceptually it still represents the policy for
   * reporting node movement:
   *
   *  var reachableMatchableProduct = [
   *  //  STAYED_OUT,  ENTERED,     STAYED_IN,   EXITED
   *    [ STAYED_OUT,  STAYED_OUT,  STAYED_OUT,  STAYED_OUT ], // STAYED_OUT
   *    [ STAYED_OUT,  ENTERED,     ENTERED,     STAYED_OUT ], // ENTERED
   *    [ STAYED_OUT,  ENTERED,     STAYED_IN,   EXITED     ], // STAYED_IN
   *    [ STAYED_OUT,  STAYED_OUT,  EXITED,      EXITED     ]  // EXITED
   *  ];
   */

  function enteredOrExited(changeType) {
    return changeType == ENTERED || changeType == EXITED;
  }

  var forEach = Array.prototype.forEach.call.bind(Array.prototype.forEach);

  function MutationProjection(rootNode) {
    this.rootNode = rootNode;
  }

  MutationProjection.prototype = {

    getChange: function(node) {
      var change = this.changeMap.get(node);
      if (!change) {
        change = {
          target: node
        };
        this.changeMap.set(node, change);
      }

      return change;
    },

    getParentChange: function(node) {
      var change = this.getChange(node);
      if (!change.childList) {
        change.childList = true;
        change.oldParentNode = null;
      }

      return change;
    },

    handleChildList: function(mutation) {
      this.childListChanges = true;

      forEach(mutation.removedNodes, function(el) {
        var change = this.getParentChange(el);

        if (change.added || change.oldParentNode)
          change.added = false;
        else
          change.oldParentNode = mutation.target;
      }, this);

      forEach(mutation.addedNodes, function(el) {
        var change = this.getParentChange(el);
        change.added = true;
      }, this);
    },

    handleAttributes: function(mutation) {
      this.attributesChanges = true;

      var change = this.getChange(mutation.target);
      if (!change.attributes) {
        change.attributes = true;
        change.attributeOldValues = {};
      }

      var oldValues = change.attributeOldValues;
      if (!hasOwnProperty(oldValues, mutation.attributeName)) {
        oldValues[mutation.attributeName] = mutation.oldValue;
      }
    },

    handleCharacterData: function(mutation) {
      this.characterDataChanges = true;

      var change = this.getChange(mutation.target);
      if (change.characterData)
        return;
      change.characterData = true;
      change.characterDataOldValue = mutation.oldValue;
    },

    processMutations: function(mutations) {
      this.mutations = mutations;
      this.changeMap = new NodeMap;

      this.mutations.forEach(function(mutation) {
        switch (mutation.type) {
          case 'childList':
            this.handleChildList(mutation);
            break;
          case 'attributes':
            this.handleAttributes(mutation);
            break;
          case 'characterData':
            this.handleCharacterData(mutation);
            break;
        }
      }, this);

      // Calculate node movement.
      var entered = this.entered = [];
      var exited = this.exited = [];
      var stayedIn = this.stayedIn = new NodeMap;

      if (!this.childListChanges && !this.attributesChanges)
        return; // No childList or attributes mutations occurred.

      var matchabilityChange = this.matchabilityChange.bind(this);

      var reachabilityChange = this.reachabilityChange.bind(this);
      var wasReordered = this.wasReordered.bind(this);

      var visited = new NodeMap;
      var self = this;

      function visitNode(node, parentReachable) {
        if (visited.has(node))
          return;
        visited.set(node, true);

        var change = self.changeMap.get(node);
        var reachable = parentReachable;

        // node inherits its parent's reachability change unless
        // its parentNode was mutated.
        if ((change && change.childList) || reachable == undefined)
          reachable = reachabilityChange(node);

        if (reachable == STAYED_OUT)
          return;

        // Cache match results for sub-patterns.
        matchabilityChange(node);

        if (reachable == ENTERED) {
          entered.push(node);
        } else if (reachable == EXITED) {
          exited.push(node);
        } else if (reachable == STAYED_IN) {
          var movement = STAYED_IN;

          if (change && change.childList) {
            if (change.oldParentNode !== node.parentNode) {
              movement = REPARENTED;
            } else if (self.calcReordered && wasReordered(node)) {
              movement = REORDERED;
            }
          }

          stayedIn.set(node, movement);
        }

        if (reachable == STAYED_IN)
          return;

        // reachable == ENTERED || reachable == EXITED.
        for (var child = node.firstChild; child; child = child.nextSibling) {
          visitNode(child, reachable);
        }
      }

      this.changeMap.keys().forEach(function(node) {
        visitNode(node);
      });
    },

    getChanged: function(summary) {
      var matchabilityChange = this.matchabilityChange.bind(this);

      this.entered.forEach(function(node) {
        var matchable = matchabilityChange(node);
        if (matchable == ENTERED || matchable == STAYED_IN)
          summary.added.push(node);
      });

      this.stayedIn.keys().forEach(function(node) {
        var matchable = matchabilityChange(node);

        if (matchable == ENTERED) {
          summary.added.push(node);
        } else if (matchable == EXITED) {
          summary.removed.push(node);
        } else if (matchable == STAYED_IN && (summary.reparented || summary.reordered)) {
          var movement = this.stayedIn.get(node);
          if (summary.reparented && movement == REPARENTED)
            summary.reparented.push(node);
          else if (summary.reordered && movement == REORDERED)
            summary.reordered.push(node);
        }
      }, this);

      this.exited.forEach(function(node) {
        var matchable = matchabilityChange(node);
        if (matchable == EXITED || matchable == STAYED_IN)
          summary.removed.push(node);
      })
    },

    getOldAttribute: function(element, attrName) {
      var change = this.changeMap.get(element);
      if (!change || !change.attributes)
        throw Error('getOldAttribute requested on invalid node.');

      if (!hasOwnProperty(change.attributeOldValues, attrName))
        throw Error('getOldAttribute requested for unchanged attribute name.');

      return change.attributeOldValues[attrName];
    },

    getAttributesChanged: function(postFilter) {
      if (!this.attributesChanges)
        return {}; // No attributes mutations occurred.

      var attributeFilter;
      if (postFilter) {
        attributeFilter = {};
        postFilter.forEach(function(attrName) {
          attributeFilter[attrName] = true;
        });
      }

      var result = {};

      var nodes = this.changeMap.keys();
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];

        if (STAYED_IN != this.reachabilityChange(node) || STAYED_IN != this.matchabilityChange(node))
          continue;

        var change = this.changeMap.get(node);
        if (!change.attributes)
          continue;

        var element = node;
        var oldValues = change.attributeOldValues;

        Object.keys(oldValues).forEach(function(name) {
          if (attributeFilter && !attributeFilter[name])
            return;

          if (element.getAttribute(name) == oldValues[name])
            return;

          if (!result[name])
            result[name] = [];

          result[name].push(element);
        });
      }

      return result;
    },

    getOldCharacterData: function(node) {
      var change = this.changeMap.get(node);
      if (!change || !change.characterData)
        throw Error('getOldCharacterData requested on invalid node.');

      return change.characterDataOldValue;
    },

    getCharacterDataChanged: function() {
      if (!this.characterDataChanges)
        return []; // No characterData mutations occurred.

      var nodes = this.changeMap.keys();
      var result = [];
      for (var i = 0; i < nodes.length; i++) {
        var target = nodes[i];
        if (STAYED_IN != this.reachabilityChange(target) || STAYED_IN != this.matchabilityChange(target))
          continue;

        var change = this.changeMap.get(target);
        if (!change.characterData ||
            target.textContent == change.characterDataOldValue)
          continue

        result.push(target);
      }

      return result;
    },

    /**
     * Returns whether a given node:
     *
     *    STAYED_OUT, ENTERED, STAYED_IN or EXITED
     *
     * the set of nodes reachable from the root.
     *
     * These four states are the permutations of whether the node
     *
     *   wasReachable(node)
     *   isReachable(node)
     *
     *
     * Complexity: O(log n)
     *   n: The number of nodes in the fragment.
     */
    reachabilityChange: function(node) {
      this.reachableCache = this.reachableCache || new NodeMap;
      this.wasReachableCache = this.wasReachableCache || new NodeMap;

      // Close over owned values.
      var rootNode = this.rootNode;
      var changeMap = this.changeMap;
      var reachableCache = this.reachableCache;
      var wasReachableCache = this.wasReachableCache;

      // An node's oldParent is
      //   -its present parent, if nothing happened to it
      //   -null if the first thing that happened to it was an add.
      //   -the node it was removed from if the first thing that happened to it
      //      was a remove.
      function getOldParent(node) {
        var change = changeMap.get(node);

        if (change && change.childList) {
          if (change.oldParentNode)
            return change.oldParentNode;
          if (change.added)
            return null;
        }

        return node.parentNode;
      }

      // Is the given node reachable from the rootNode.
      function getIsReachable(node) {
        if (node === rootNode)
          return true;
        if (!node)
          return false;

        var isReachable = reachableCache.get(node);
        if (isReachable === undefined) {
          isReachable = getIsReachable(node.parentNode);
          reachableCache.set(node, isReachable);
        }
        return isReachable;
      }

      // Was the given node reachable from the rootNode.
      // A node wasReachable if its oldParent wasReachable.
      function getWasReachable(node) {
        if (node === rootNode)
          return true;
        if (!node)
          return false;

        var wasReachable = wasReachableCache.get(node);
        if (wasReachable === undefined) {
          wasReachable = getWasReachable(getOldParent(node));
          wasReachableCache.set(node, wasReachable);
        }
        return wasReachable;
      }

      if (getIsReachable(node))
        return getWasReachable(node) ? STAYED_IN : ENTERED;
      else
        return getWasReachable(node) ? EXITED : STAYED_OUT;
    },

    /**
     * Returns whether a given element:
     *
     *   STAYED_OUT, ENTERED, EXITED or STAYED_IN
     *
     * the set of element which match at least one match pattern.
     *
     * These four states are the permutations of whether the element
     *
     *   wasMatching(node)
     *   isMatching(node)
     *
     *
     * Complexity: O(1)
     */
    matchabilityChange: function(node) {
      // TODO(rafaelw): Include PI, CDATA?
      // Only include text nodes.
      if (this.filterCharacterData) {
        switch (node.nodeType) {
          case Node.COMMENT_NODE:
          case Node.TEXT_NODE:
            return STAYED_IN;
          default:
            return STAYED_OUT;
        }
      }

      // No element filter. Include all nodes.
      if (!this.elementFilter)
        return STAYED_IN;

      // Element filter. Exclude non-elements.
      if (node.nodeType !== Node.ELEMENT_NODE)
        return STAYED_OUT;

      var self = this;
      var el = node;

      function computeMatchabilityChange(filter) {
        if (!self.matchCache)
          self.matchCache = {};
        if (!self.matchCache[filter.name])
          self.matchCache[filter.name] = new NodeMap;

        var cache = self.matchCache[filter.name];
        var result = cache.get(el);
        if (result !== undefined)
          return result;

        var attributeOldValues;
        var change = self.changeMap.get(el);
        if (change && change.attributeOldValues)
          attributeOldValues = change.attributeOldValues;
        else
          attributeOldValues = {};

        function checkMatch(attrValue, classAttrValue) {
          if (filter.tagName != '*' && filter.tagName != el.tagName)
            return false;

          if (filter.attrName) {
            if (attrValue == null)
              return false;
            if (filter.hasOwnProperty('attrValue') && filter.attrValue != attrValue)
              return false;
          }

          if (filter.className) {
            if (!classAttrValue)
              return false;
            var retval = classAttrValue.split(' ').some(function(cn) {
              return cn == filter.className;
            });
            return retval;
          }

          return true;
        }

        var attrValue = filter.attrName ? el.getAttribute(filter.attrName) : undefined;
        var classAttrValue = filter.className ? el.getAttribute('class') : undefined;

        var isMatching = checkMatch(attrValue, classAttrValue);
        var wasMatching = isMatching;

        // TODO(rafaelw): This will break if attrName is '__proto__'. The only fix is
        // to prefix all attributeNames here so that they don't collide with __proto__.
        // which doesn't seem worth it.
        if (filter.attrName && hasOwnProperty(attributeOldValues, filter.attrName)) {
          wasMatching = undefined;
          attrValue = attributeOldValues[filter.attrName];
        }
        if (filter.className && attributeOldValues.hasOwnProperty('class')) {
          wasMatching = undefined;
          classAttrValue = attributeOldValues['class'];
        }
        if (wasMatching === undefined)
          wasMatching = checkMatch(attrValue, classAttrValue);

        if (isMatching)
          result = wasMatching ? STAYED_IN : ENTERED;
        else
          result = wasMatching ? EXITED : STAYED_OUT;

        cache.set(el, result);
        return result;
      }

      var matchChanges = this.elementFilter.map(computeMatchabilityChange);
      var accum = STAYED_OUT;
      var i = 0;

      while (accum != STAYED_IN && i < matchChanges.length) {
        switch(matchChanges[i]) {
          case STAYED_IN:
            accum = STAYED_IN;
            break;
          case ENTERED:
            if (accum == EXITED)
              accum = STAYED_IN;
            else
              accum = ENTERED;
            break;
          case EXITED:
            if (accum == ENTERED)
              accum = STAYED_IN;
            else
              accum = EXITED;
            break;
        }

        i++;
      }

      return accum;
    },

    /**
     * Preprocessing step required for getReordered. This builds a set of
     * records, one for each parent which had nodes removed or added, and builds
     *   -A map of the nodes which were added
     *   -A map of the nodes which were removed
     *   -A map of the nodes which were "maybe moved" (removed and added back).
     *   -A map of node->old previous node (the previousSibling of the node when
     *    observation)
     *
     * Complexity: O(a)
     *   a: The number of node removals and additions which have occurred.
     *
     * See getReordered, below.
     */
    processChildlistChanges: function() {
      if (this.childlistChanges)
        return;

      var childlistChanges = this.childlistChanges = new NodeMap;

      function getChildlistChange(el) {
        var change = childlistChanges.get(el);
        if (!change) {
          change = {
            added: new NodeMap,
            removed: new NodeMap,
            maybeMoved: new NodeMap,
            oldPrevious: new NodeMap
          };
          childlistChanges.set(el, change);
        }

        return change;
      }

      var reachabilityChange = this.reachabilityChange.bind(this);

      this.mutations.forEach(function(mutation) {
        if (mutation.type != 'childList')
          return;

        if (reachabilityChange(mutation.target) != STAYED_IN)
          return;

        var change = getChildlistChange(mutation.target);

        var oldPrevious = mutation.previousSibling;

        function recordOldPrevious(node, previous) {
          if (!node ||
              change.oldPrevious.has(node) ||
              change.added.has(node) ||
              change.maybeMoved.has(node))
            return;

          if (previous &&
              (change.added.has(previous) ||
               change.maybeMoved.has(previous)))
            return;

          change.oldPrevious.set(node, previous);
        }

        forEach(mutation.removedNodes, function(node) {
          recordOldPrevious(node, oldPrevious);

          if (change.added.has(node)) {
            change.added.delete(node);
          } else {
            change.removed.set(node, true);
            change.maybeMoved.delete(node, true);
          }

          oldPrevious = node;
        });

        recordOldPrevious(mutation.nextSibling, oldPrevious);

        forEach(mutation.addedNodes, function(node) {
          if (change.removed.has(node)) {
            change.removed.delete(node);
            change.maybeMoved.set(node, true);
          } else {
            change.added.set(node, true);
          }
        });
      });
    },

    wasReordered: function(node) {
      if (!this.childListChanges)
        return false;

      this.processChildlistChanges();

      var change = this.childlistChanges.get(node.parentNode);
      if (change.moved)
        return change.moved.get(node);

      var moved = change.moved = new NodeMap;
      var pendingMoveDecision = new NodeMap;

      function isFirstOfPending(node) {
        // Ensure that the result is deterministic.
        while (node = node.previousSibling) {
          if (pendingMoveDecision.has(node))
            return false;
        }

        return true;
      }

      function isMoved(node) {
        if (!node)
          return false;
        if (!change.maybeMoved.has(node))
          return false;

        var didMove = moved.get(node);
        if (didMove !== undefined)
          return didMove;

        if (pendingMoveDecision.has(node)) {
          didMove = isFirstOfPending(node);
        } else {
          pendingMoveDecision.set(node, true);
          didMove = getPrevious(node) !== getOldPrevious(node);
        }

        if (pendingMoveDecision.has(node)) {
          pendingMoveDecision.delete(node);
          moved.set(node, didMove);
        } else {
          didMove = moved.get(node);
        }

        return didMove;
      }

      var oldPreviousCache = new NodeMap;
      function getOldPrevious(node) {
        var oldPrevious = oldPreviousCache.get(node);
        if (oldPrevious !== undefined)
          return oldPrevious;

        oldPrevious = change.oldPrevious.get(node);
        while (oldPrevious &&
               (change.removed.has(oldPrevious) || isMoved(oldPrevious))) {
          oldPrevious = getOldPrevious(oldPrevious);
        }

        if (oldPrevious === undefined)
          oldPrevious = node.previousSibling;
        oldPreviousCache.set(node, oldPrevious);

        return oldPrevious;
      }

      var previousCache = new NodeMap;
      function getPrevious(node) {
        if (previousCache.has(node))
          return previousCache.get(node);

        var previous = node.previousSibling;
        while (previous && (change.added.has(previous) || isMoved(previous)))
          previous = previous.previousSibling;

        previousCache.set(node, previous);
        return previous;
      }

      change.maybeMoved.keys().forEach(isMoved);
      return change.moved.get(node);
    }
  }

  var validNameInitialChar = /[a-zA-Z:_]+/;
  var validNameNonInitialChar = /[a-zA-Z0-9_\-:\.]+/;

  // TODO(rafaelw): Consider allowing backslash in the attrValue.
  function parseElementFilter(elementFilter) {
    var patterns = [];
    var current;
    var index = 0;

    var WHITESPACE = /\s/;

    var OUTSIDE = 0;
    var TAG_NAME = 1;
    var CLASS_NAME = 2;
    var BEGIN_ATTR_NAME = 3;
    var ATTR_NAME = 4;
    var END_ATTR_NAME = 5;
    var BEGIN_VALUE = 6;
    var VALUE = 7;
    var QUOTED_VALUE = 8;
    var END_VALUE = 9;
    var valueQuoteChar;

    var SYNTAX_ERROR = 'Invalid element syntax.';

    var state = OUTSIDE;
    var i = 0;
    while (i < elementFilter.length) {
      var c = elementFilter[i++];
      switch (state) {
        case OUTSIDE:
          if (c.match(validNameInitialChar)) {
            current = {
              tagName: c
            };
            state = TAG_NAME;
            break;
          }
          if (c == '*') {
            current = {
              tagName: '*'
            };
            state = TAG_NAME;
            break;
          }
          if (c == '.') {
            current = {
              tagName: '*',
              className: ''
            };
            state = CLASS_NAME;
            break;
          }
          if (c.match(WHITESPACE))
            break;

          throw Error(SYNTAX_ERROR);

        case TAG_NAME:
          if (c == '.') {
            current.className = '';
            state = CLASS_NAME;
            break;
          }
          if (c.match(validNameNonInitialChar) && current.tagName != '*') {
            current.tagName += c;
            break;
          }
          if (c == '[') {
            state = BEGIN_ATTR_NAME;
            break;
          }
          if (c.match(WHITESPACE)) {
            patterns.push(current);
            current = undefined;
            state = OUTSIDE;
            break;
          }

          throw Error(SYNTAX_ERROR);

        case CLASS_NAME:
          if (c.match(validNameNonInitialChar)) {
            current.className += c;
            break;
          }
          if (c.match(WHITESPACE)) {
            patterns.push(current);
            current = undefined;
            state = OUTSIDE;
            break;
          }

          throw Error(SYNTAX_ERROR);

        case BEGIN_ATTR_NAME:
          if (c.match(WHITESPACE))
            break;

          if (c.match(validNameInitialChar)) {
            state = ATTR_NAME;
            current.attrName = c;
            break;
          }

          throw Error(SYNTAX_ERROR);

        case ATTR_NAME:
          if (c.match(validNameNonInitialChar)) {
            current.attrName += c;
            break;
          }
          if (c.match(WHITESPACE)) {
            state = END_ATTR_NAME;
            break;
          }
          if (c == '=') {
            state = BEGIN_VALUE;
            break;
          }
          if (c == ']') {
            patterns.push(current);
            current = undefined;
            state = OUTSIDE;
            break;
          }

          throw Error(SYNTAX_ERROR);

        case END_ATTR_NAME:
          if (c == ']') {
            patterns.push(current);
            current = undefined;
            state = OUTSIDE;
            break;
          }
          if (c == '=') {
            state = BEGIN_VALUE;
            break;
          }
          if (c.match(WHITESPACE))
            break;

          throw Error(SYNTAX_ERROR);

        case BEGIN_VALUE:
          if (c == '"' || c == "'") {
            valueQuoteChar = c;
            current.attrValue = '';
            state = QUOTED_VALUE;
            break;
          }
          if (c.match(WHITESPACE))
            break;

          state = VALUE;
          current.attrValue = c;
          break;

        case VALUE:
          if (c.match(WHITESPACE)) {
            state = END_VALUE;
            break;
          }
          if (c == ']') {
            patterns.push(current);
            current = undefined;
            state = OUTSIDE;
            break;
          }
          current.attrValue += c;
          break;
        case QUOTED_VALUE:
          if (c.match(WHITESPACE)) {
            current.attrValue += c;
            break;
          }
          if (c == valueQuoteChar) {
            state = END_VALUE;
            valueQuoteChar = undefined;
            break;
          }
          current.attrValue += c;
          break;
        case END_VALUE:
          if (c == ']') {
            patterns.push(current);
            current = undefined;
            state = OUTSIDE;
            break;
          }
          if (c.match(WHITESPACE)) {
            break;
          }

          throw Error(SYNTAX_ERROR);
          break;
      }
    }

    if (current) {
      if ((state == TAG_NAME) || (state == CLASS_NAME && current.className.length))
        patterns.push(current);
      else
        throw Error(SYNTAX_ERROR);
    }

    patterns.forEach(function(pattern) {
      pattern.tagName = pattern.tagName.toUpperCase();
      pattern.name = pattern.tagName;
      if (pattern.className) {
        pattern.name += '.' + pattern.className;
      }
      if (pattern.attrName) {
        pattern.name += '[' + pattern.attrName;
        if (pattern.hasOwnProperty('attrValue'))
          pattern.name += '="' + pattern.attrValue.replace(/"/, '\\\"') + '"';
        pattern.name += ']';
      }
    });

    if (!patterns.length)
      throw Error(SYNTAX_ERROR);

    return patterns;
  }

  var attributeFilterPattern = /^([a-zA-Z:_]+[a-zA-Z0-9_\-:\.]*)$/;

  function validateAttribute(attribute) {
    if (typeof attribute != 'string')
      throw Error('Invalid request opion. attribute must be a non-zero length string.');

    attribute = attribute.trim();

    if (!attribute)
      throw Error('Invalid request opion. attribute must be a non-zero length string.');


    if (!attribute.match(attributeFilterPattern))
      throw Error('Invalid request option. invalid attribute name: ' + attribute);

    return attribute;
  }

  function validateElementAttributes(attribs) {
    if (!attribs.trim().length)
      throw Error('Invalid request option: elementAttributes must contain at least one attribute.');

    var attributes = {};

    var tokens = attribs.split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var attribute = tokens[i];
      if (!attribute)
        continue;

      attributes[validateAttribute(attribute)] = true;
    }

    return Object.keys(attributes);
  }

  function validateOptions(options) {
    var validOptions = {
      'callback': true, // required
      'queries': true,  // required
      'rootNode': true,
      'observeOwnChanges': true
    };

    var opts = {};

    for (var opt in options) {
      if (!(opt in validOptions))
        throw Error('Invalid option: ' + opt);
    }

    if (typeof options.callback !== 'function')
      throw Error('Invalid options: callback is required and must be a function');

    opts.callback = options.callback;
    opts.rootNode = options.rootNode || document;
    opts.observeOwnChanges = options.observeOwnChanges;

    if (!options.queries || !options.queries.length)
      throw Error('Invalid options: queries must contain at least one query request object.');

    opts.queries = [];

    for (var i = 0; i < options.queries.length; i++) {
      var request = options.queries[i];

      // all
      if (request.all) {
        if (Object.keys(request).length > 1)
          throw Error('Invalid request option. all has no options.');

        opts.queries.push({all: true});
        continue;
      }

      // attribute
      if (request.hasOwnProperty('attribute')) {
        var query = {
          attribute: validateAttribute(request.attribute)
        };

        query.elementFilter = parseElementFilter('*[' + query.attribute + ']');

        if (Object.keys(request).length > 1)
          throw Error('Invalid request option. attribute has no options.');

        opts.queries.push(query);
        continue;
      }

      // element
      if (request.hasOwnProperty('element')) {
        var requestOptionCount = Object.keys(request).length;
        var query = {
          element: request.element,
          elementFilter: parseElementFilter(request.element)
        };

        if (request.hasOwnProperty('elementAttributes')) {
          query.elementAttributes = validateElementAttributes(request.elementAttributes);
          requestOptionCount--;
        }

        if (requestOptionCount > 1)
          throw Error('Invalid request option. element only allows elementAttributes option.');

        opts.queries.push(query);
        continue;
      }

      // characterData
      if (request.characterData) {
        if (Object.keys(request).length > 1)
          throw Error('Invalid request option. characterData has no options.');

        opts.queries.push({ characterData: true });
        continue;
      }

      throw Error('Invalid request option. Unknown query request.');
    }

    return opts;
  }

  function elementFilterAttributes(filters) {
    var attributes = {};

    filters.forEach(function(filter) {
      if (filter.attrName)
        attributes[filter.attrName] = true;
    });

    return Object.keys(attributes);
  }

  function createObserverOptions(queries) {
    var observerOptions = {
      childList: true,
      subtree: true
    };

    var attributeFilter;
    function observeAttributes(attributes) {
      if (observerOptions.attributes && !attributeFilter)
        return; // already observing all.

      observerOptions.attributes = true;
      observerOptions.attributeOldValue = true;

      if (!attributes) {
        // observe all.
        attributeFilter = undefined;
        return;
      }

      // add to observed.
      attributeFilter = attributeFilter || {};
      attributes.forEach(function(attribute) {
        attributeFilter[attribute] = true;
      });
    }

    queries.forEach(function(request) {
      if (request.characterData) {
        observerOptions.characterData = true;
        observerOptions.characterDataOldValue = true;
        return;
      }

      if (request.all) {
        observeAttributes();
        observerOptions.characterData = true;
        observerOptions.characterDataOldValue = true;
        return;
      }

      if (request.attribute) {
        observeAttributes([request.attribute.trim()]);
        return;
      }

      if (request.elementFilter && request.elementFilter.some(function(f) { return f.className; } ))
         observeAttributes(['class']);

      var attributes = elementFilterAttributes(request.elementFilter).concat(request.elementAttributes || []);
      if (attributes.length)
        observeAttributes(attributes);
    });

    if (attributeFilter)
      observerOptions.attributeFilter = Object.keys(attributeFilter);

    return observerOptions;
  }

  function createSummary(projection, root, query) {
    projection.elementFilter = query.elementFilter;
    projection.filterCharacterData = query.characterData;

    var summary = {
      target: root,
      type: 'summary',
      added: [],
      removed: [],
      reparented: query.all || query.element ? [] : undefined,
      reordered: query.all ? [] : undefined
    };

    projection.getChanged(summary);

    if (query.all || query.attribute || query.elementAttributes) {
      var attributeChanged = projection.getAttributesChanged(query.elementAttributes);

      if (query.attribute) {
        summary.valueChanged = [];
        if (attributeChanged[query.attribute])
          summary.valueChanged = attributeChanged[query.attribute];

        summary.getOldAttribute = function(node) {
          return projection.getOldAttribute(node, query.attribute);
        }
      } else {
        summary.attributeChanged = attributeChanged;
        summary.getOldAttribute = projection.getOldAttribute.bind(projection);
      }
    }

    if (query.all || query.characterData) {
      var characterDataChanged = projection.getCharacterDataChanged()
      summary.getOldCharacterData = projection.getOldCharacterData.bind(projection);

      if (query.characterData)
        summary.valueChanged = characterDataChanged;
      else
        summary.characterDataChanged = characterDataChanged;
    }

    return summary;
  }

  function MutationSummary(opts) {
    var options = validateOptions(opts);
    var observerOptions = createObserverOptions(options.queries);

    var root = options.rootNode;
    var callback = options.callback;

    var queryValidators;
    if (MutationSummary.createQueryValidator) {
      queryValidators = [];
      options.queries.forEach(function(query) {
        queryValidators.push(MutationSummary.createQueryValidator(root, query));
      });
    }

    var observer = new WebKitMutationObserver(function(mutations) {
      if (!options.observeOwnChanges) {
        observer.disconnect();
      }

      var projection = new MutationProjection(root);
      var elementFilter = [];
      options.queries.forEach(function(query) {
        if (query.all)
          projection.calcReordered = true;

        if (query.elementFilter) {
          elementFilter = elementFilter.concat(query.elementFilter);
          projection.elementFilter = elementFilter;
        }
      });
      projection.processMutations(mutations);

      var summaries = [];
      options.queries.forEach(function(query) {
        summaries.push(createSummary(projection, root, query));
      });

      if (queryValidators) {
        queryValidators.forEach(function(validator, index) {
          if (!validator)
            return;
          validator.validate(summaries[index]);
        });
      }

      callback(summaries);

      if (!options.observeOwnChanges) {
        observer.observe(root, observerOptions);
      }
    });

    observer.observe(root, observerOptions);

    this.disconnect = function() {
      observer.disconnect();
    };
  }

  // Externs
  global.MutationSummary = MutationSummary;
  global.MutationSummary.NodeMap = NodeMap;
})(this);
