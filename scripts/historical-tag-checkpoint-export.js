#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { parseArgs } = require('./historical-direct-tag-supplement.js');
function parsePaperIds(raw) {
 const ids = String(raw).split(',');
 const valid = id => {
  if (/^arxiv:\d{4}\.\d{4,5}$/.test(id)) return true;
  const match = /^conference:([^:]+):(\d{4}):([^:]+):([^:]+)$/.exec(id);
  if (!match) return false;
  try {
   return require('./lib/paper-identity.js').canonicalConferencePaperId(
    { id: match[1] + '-' + match[2], year: Number(match[2]) }, { type: match[3], value: match[4] }) === id;
  } catch {
   return false;
  }
 };
 if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !valid(id)))
  throw new Error('排除论文编号的格式无效，或包含重复编号。');
 return ids;
}
async function main(argv = process.argv.slice(2)) {
 require('./env-loader.js').requireExternalRuntime('historical-tag-checkpoint-export');
 require('./workspace-role.js').requireWorkspaceRole('history');
 const args = [...argv];
 const checkpointArgumentIndex = args.indexOf('--checkpoint');
 if (checkpointArgumentIndex < 0 || !path.isAbsolute(args[checkpointArgumentIndex + 1] || ''))
  throw new Error('必须用 --checkpoint 指定检查点文件的绝对路径。');
 const checkpointFile = args[checkpointArgumentIndex + 1];
 args.splice(checkpointArgumentIndex, 2);
 const excludedPaperIdsArgumentIndex = args.indexOf('--exclude-paper-ids');
 let excludePaperIds = [];
 if (excludedPaperIdsArgumentIndex >= 0) {
  excludePaperIds = parsePaperIds(args[excludedPaperIdsArgumentIndex + 1] || '');
  args.splice(excludedPaperIdsArgumentIndex, 2);
 }
 const options = { ...parseArgs(args), checkpointFile, excludePaperIds };
 const config = require('./config.js');
 if (!config.FILES.historicalSourceTagAssignmentDir)
  throw new Error('集中配置必须提供来源标签分类目录。');
 const result = await require('./lib/historical-tag-checkpoint-export.js').exportCheckpoint(options);
 const writer = require('./lib/historical-direct-tag-supplement.js');
 const directory = path.join(config.FILES.historicalSourceTagAssignmentDir, 'checkpoint-exports', options.runId);
 const outputs = [writer.writeImmutable(directory, 'tag-history.json', result.supplement),
  writer.writeImmutable(directory, 'report.json', result.report)];
 console.log(JSON.stringify({ ...result.report, processedPaperIds: undefined, remainingPaperIds: undefined,
  failures: undefined, outputs }));
 return result;
}
if (require.main === module) main().catch(error => {
 console.error(error.message);
 process.exitCode = 1;
});
module.exports = { main, parsePaperIds };
