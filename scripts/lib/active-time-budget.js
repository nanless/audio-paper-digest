'use strict';

// Shared active-time accounting; long stalls may be system suspend or local event-loop blockage.
function createActiveTimeBudget(totalMs, options = {}) {
    const now = options.now || Date.now;
    const tickMs = options.tickMs || 1000;
    const suspendThresholdMs = options.suspendThresholdMs || 30000;
    let lastSample = now();
    let activeElapsedMs = 0;
    let excludedSuspendMs = 0;
    let stopped = false;

    const sample = () => {
        if (stopped) return;
        const current = now();
        const delta = Math.max(0, current - lastSample);
        lastSample = current;
        if (delta > suspendThresholdMs) {
            const resumeCost = Math.min(delta, tickMs * 2);
            activeElapsedMs += resumeCost;
            excludedSuspendMs += delta - resumeCost;
        } else {
            activeElapsedMs += delta;
        }
    };
    const timer = options.autoStart === false ? null : setInterval(sample, tickMs);
    timer?.unref?.();

    return {
        elapsedMs() { sample(); return Math.min(totalMs, Math.floor(activeElapsedMs)); },
        suspendedMs() { sample(); return Math.floor(excludedSuspendMs); },
        stop() {
            sample();
            stopped = true;
            if (timer) clearInterval(timer);
        }
    };
}

module.exports = { createActiveTimeBudget };
