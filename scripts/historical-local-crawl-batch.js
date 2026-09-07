#!/usr/bin/env node
'use strict';

const retired = require('./historical-archive-crawl-batch.js');
if (require.main === module) retired.main().catch(error => { console.error(`[historical-local-crawl-batch] ${error.message}`); process.exitCode = 1; });
module.exports = retired;
