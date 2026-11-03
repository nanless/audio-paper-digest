'use strict';

// Serialization recognition only. Source, original bytes, signatures, budgets
// and publication eligibility remain the responsibility of the normal caller.
function createPublicProtocolApi(entries) {
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  const reserved=['contract','schemaFingerprint','version','schemaVersion','policyVersion','__proto__'];
  function entry(name) {
    if (typeof name!=='string'||!own(entries,name)) throw new Error('Unknown public protocol family');
    return entries[name];
  }
  function choices(raw,name) {
    return entry(name).formats.filter(value=>value.tag===raw);
  }
  function select(raw,name,selectors) {
    const found=choices(raw,name).filter(value=>!selectors.length||value.fp===(selectors[0]??null));
    if(found.length!==1)throw new Error('Public format requires its exact original tag/fingerprint');
    return found[0];
  }
  function isContract(raw,name,variant,...selectors) {
    const found=choices(raw,name).filter(value=>!selectors.length||value.fp===(selectors[0]??null));
    return found.length>0 && (variant===undefined||found.every(value=>value.variant===variant));
  }
  function format(raw,name,...selectors) { return select(raw,name,selectors).variant; }
  function recordHeader(raw,name,...selectors) {
    const value=raw===name&&!selectors.length?entry(name).formats.find(value=>!value.historical):select(raw,name,selectors);
    return JSON.parse(JSON.stringify(value.header));
  }
  function declaredSchema(raw,name,...selectors) {
    const value=select(raw,name,selectors);
    if(!value.schema)throw new Error('This historical format has no complete schema declaration');
    return JSON.parse(JSON.stringify(value.schema));
  }
  function contract(name) { entry(name); return name; }
  function historicalContract(name,variant) {
    const values=entry(name).formats.filter(value=>value.historical&&value.variant===variant);
    if(values.length!==1||values[0].fp!==null||choices(values[0].tag,name).length!==1)throw new Error('Historical fingerprint requires its complete header');
    return values[0].tag;
  }
  function historicalHeader(name,variant,...selectors) {
    const values=entry(name).formats.filter(value=>value.historical&&value.variant===variant&&(!selectors.length||value.fp===(selectors[0]??null)));
    if(values.length!==1)throw new Error('Historical format requires its exact declaration');
    return JSON.parse(JSON.stringify(values[0].header));
  }
  function hasValidHeader(record,name,tagField='contract') {
    if (!record || typeof record!=='object' || Array.isArray(record) || !own(record,tagField)) return false;
    let expected;
    try { expected=recordHeader(record[tagField],name,record.schemaFingerprint); } catch (_) { return false; }
    return [...new Set([...reserved,...Object.keys(expected)])].every(key=>own(expected,key)
      ? own(record,key) && typeof record[key]===typeof expected[key] && record[key]===expected[key]
      : !own(record,key));
  }
  function record(name,fields={}) {
    if (!fields || Object.getPrototypeOf(fields)!==Object.prototype || reserved.some(key=>own(fields,key))) throw new Error('Protocol fields cannot override its header');
    return Object.assign(recordHeader(contract(name),name),fields);
  }
  return Object.freeze({contract,historicalContract,historicalHeader,isContract,format,recordHeader,declaredSchema,hasValidHeader,record,
    isCurrentHeader:(value,name,field='contract')=>hasValidHeader(value,name,field)&&value[field]===name&&value.schemaFingerprint===entry(name).schemaFingerprint,
    schemaFingerprint:name=>entry(name).schemaFingerprint,
    identityDomain:(raw,name,...selectors)=>{format(raw,name,...selectors);return raw;}});
}

module.exports = createPublicProtocolApi;
