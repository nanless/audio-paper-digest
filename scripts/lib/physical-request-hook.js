'use strict';

// Leaf hook decoupling scripts/utils.js from scripts/lib/explicit-reader-retry-round.js.
// Zero local project imports; explicit-reader-retry-round.js registers its physical
// request consumer upon module load (and entering an explicit round always loads it first).

let registeredConsumer = null;

function registerPhysicalRequestConsumer(fn) {
    if (fn !== null && fn !== undefined && typeof fn !== 'function') {
        throw new TypeError('physical request consumer must be a function or null');
    }
    const previous = registeredConsumer;
    registeredConsumer = fn || null;
    return previous;
}

function getPhysicalRequestConsumer() {
    return registeredConsumer;
}

function consumePhysicalRequest(bodyObj, options) {
    if (typeof registeredConsumer === 'function') {
        return registeredConsumer(bodyObj, options);
    }
    return undefined;
}

module.exports = {
    registerPhysicalRequestConsumer,
    getPhysicalRequestConsumer,
    consumePhysicalRequest
};
