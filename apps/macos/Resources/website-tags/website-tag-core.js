(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ResearchTags = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONTRACT = 'paper-tag-flat-tags-v2';
  var LEGACY_CONTRACT = 'paper-taxonomy-flat-tags-compat-v1';
  var V2_CONTRACT = 'historical-source-taxonomy-classification-v2';
  var V3_CONTRACT = 'historical-source-taxonomy-classification-v3';
  var QUALIFIED_CONTRACT = 'exact1028-independent-review-qualified-classification-v1';
  var SNAPSHOT_CONTRACT = 'paper-tag-catalog-snapshot-v2';
  var LEGACY_SNAPSHOT_CONTRACT = 'paper-taxonomy-registry-snapshot-v1';
  var VERSIONS_CONTRACT = 'paper-tag-catalog-versions-v2';
  var LEGACY_VERSIONS_CONTRACT = 'paper-taxonomy-version-catalog-v1';
  var researchTypeLabels = Object.freeze({ engineering: '工程研究', science: '科学研究', analysis: '机制分析',
    evaluation: '评测研究', resource: '研究资源', review: '综述', experience: '实践报告', position: '观点论文' });
  var domainLabels = Object.freeze({ 'in-domain': '音频研究', 'cross-domain': '跨域交叉',
    'adjacent-domain': '相邻声学', 'out-of-domain': '其他领域' });
  var roleFacets = Object.freeze({ engineering: ['task'], science: ['scientific_topic'],
    analysis: ['scientific_topic', 'research_focus'], evaluation: ['research_focus'], resource: ['artifact'],
    review: ['task', 'scientific_topic', 'research_focus'],
    experience: ['task', 'scientific_topic', 'research_focus', 'artifact'],
    position: ['scientific_topic', 'research_focus'] });
  var roleLabels = Object.freeze({ task: '主要研究任务', scientific_topic: '主要研究主题',
    research_focus: '主要研究重点', artifact: '主要研究产物', method: '主要研究方法' });
  var facetLabels = Object.freeze({ task: '任务', method: '方法', setting: '条件', signal: '信号',
    application: '应用', research_focus: '研究重点', artifact: '研究产物',
    scientific_topic: '科学主题', model_family: '模型家族' });
  var own = function (object, key) { return Object.prototype.hasOwnProperty.call(object, key); };
  var tagFieldNames = [
    ['tagContract', 'taxonomyContract'], ['tagConcepts', 'taxonomyConcepts'],
    ['tagCatalogSha256', 'taxonomyRegistrySha256'], ['tagPublicationStatus', 'taxonomyPublicationStatus'],
    ['tagEvidenceContract', 'taxonomyEvidenceContract'], ['tagEvidenceType', 'taxonomyEvidenceType'],
    ['tagProofSha256', 'taxonomyProofSha256'], ['tagPageSha256', 'taxonomyPageSha256'],
    ['tagClassificationContract', 'taxonomyClassificationContract']
  ];
  function readTagFields(record) {
    var hasCurrent = tagFieldNames.some(function (names) { return own(record, names[0]); });
    var hasLegacy = tagFieldNames.some(function (names) { return own(record, names[1]); });
    if (hasCurrent && hasLegacy) throw new Error('标签字段不能混用新旧命名。');
    var fields = {};
    tagFieldNames.forEach(function (names) { fields[names[0]] = record[names[hasCurrent ? 0 : 1]]; });
    return fields;
  }
  var text = function (value) { return typeof value === 'string' ? value.trim() : ''; };
  var normalized = function (value) { return text(value).normalize('NFKC').toLocaleLowerCase(); };
  var isActive = function (node) { return !!node && node.status !== 'deprecated'; };
  function readerScopeNote(value) {
    return text(value).split(/(?<=[。！？])/).filter(function (sentence) {
      return !/(?:父节点缺失故成根|按报告指定成根)/.test(sentence);
    }).join('').trim();
  }

  function sameSnapshotContent(left, right) {
    function sameValue(a, b) {
      if (a === b) return true;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
      var keys = Object.keys(a);
      return keys.length === Object.keys(b).length && keys.every(function (key) { return own(b, key) && sameValue(a[key], b[key]); });
    }
    var keys = Object.keys(left).filter(function (key) { return key !== 'contract'; });
    return keys.length === Object.keys(right).filter(function (key) { return key !== 'contract'; }).length
      && keys.every(function (key) { return own(right, key) && sameValue(left[key], right[key]); });
  }
  function loadDisplayAssets(indexUrl, fetchImpl) {
    var options = { credentials: 'same-origin', redirect: 'error' };
    function request(filename) { return fetchImpl(new URL('data/' + filename, indexUrl), options); }
    function readOld(filename) {
      return fetchImpl(new URL('data/' + filename, indexUrl), { credentials: 'same-origin' }).then(function (response) { return response && response.ok ? response.json() : null; })
        .catch(function () { return null; });
    }
    return Promise.all([request('tag-catalog-snapshot.json'), request('tag-catalog-versions.json')]).then(function (responses) {
      if (responses.every(function (response) { return response && response.status === 404; })) {
        return Promise.all([readOld('taxonomy-registry.json'), readOld('taxonomy-catalog.json')])
          .then(function (values) { return { snapshot: values[0], versions: values[1] }; });
      }
      if (responses.some(function (response) { return !response || !response.ok; })) throw new Error('新版标签显示资源缺失或读取失败。');
      return Promise.all(responses.map(function (response) { return response.json(); })).then(function (values) {
        var snapshot = values[0], versions = values[1];
        if (!snapshot || snapshot.contract !== SNAPSHOT_CONTRACT || !versions || versions.contract !== VERSIONS_CONTRACT) {
          throw new Error('新版标签显示资源的格式不受支持。');
        }
        createRegistry(snapshot, versions);
        return { snapshot: snapshot, versions: versions };
      });
    });
  }

  // 词表快照使用有序祖先链；不完整或不支持的图须拒绝，不能将任意数组当作分类树。
  function createRegistry(snapshot, catalog) {
    if (!snapshot || !Array.isArray(snapshot.concepts) || !snapshot.concepts.length) {
      throw new Error('分类目录缺少概念');
    }
    if (snapshot.contract && ![SNAPSHOT_CONTRACT, LEGACY_SNAPSHOT_CONTRACT].includes(snapshot.contract)) {
      throw new Error('分类目录版本不受支持');
    }
    var byId = Object.create(null);
    var childrenById = Object.create(null);
    var rootsByFacet = Object.create(null);
    var descendantsById = Object.create(null);
    var labelsByFacet = Object.create(null);
    Object.keys(facetLabels).forEach(function (facet) { rootsByFacet[facet] = []; });
    snapshot.concepts.forEach(function (record) {
      if (!record || Array.isArray(record) || typeof record !== 'object') throw new Error('分类概念非法');
      var id = text(record.id);
      var facet = text(record.facet);
      var zh = text(record.zh);
      if (!id || !/^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9.-]*$/.test(id) || !own(facetLabels, facet)
        || !id.startsWith(facet + '.') || !zh || own(byId, id)) throw new Error('分类标识重复或非法');
      if (!Array.isArray(record.ancestorIds) || !Array.isArray(record.aliases)
        || record.ancestorIds.some(function (value) { return !text(value); })
        || record.aliases.some(function (value) { return !text(value); })
        || (record.status && !['active', 'deprecated'].includes(record.status))
        || (record.parentIds && (!Array.isArray(record.parentIds) || record.parentIds.length > 1))) {
        throw new Error('分类路径或别名非法');
      }
      var node = { id: id, facet: facet, zh: zh, en: text(record.en), aliases: record.aliases.slice(),
        ancestorIds: record.ancestorIds.slice(), parentId: record.ancestorIds.at(-1) || null,
        status: record.status || 'active', definition: text(record.definition || record.description),
        scopeNote: text(record.scopeNote) };
      byId[id] = node;
      childrenById[id] = [];
      descendantsById[id] = [];
      [zh, node.en].concat(node.aliases).filter(Boolean).forEach(function (label) {
        var key = facet + '\u0000' + normalized(label);
        if (own(labelsByFacet, key) && labelsByFacet[key] !== id) throw new Error('分类别名存在歧义');
        labelsByFacet[key] = id;
      });
    });
    Object.values(byId).forEach(function (node) {
      var seen = new Set([node.id]);
      var expected = [];
      var parentId = node.parentId;
      while (parentId) {
        var parent = byId[parentId];
        if (!parent || parent.facet !== node.facet || seen.has(parentId) || !isActive(parent)) {
          throw new Error('分类父级缺失、跨分面或形成循环');
        }
        seen.add(parentId);
        expected.unshift(parentId);
        parentId = parent.parentId;
      }
      if (expected.length !== node.ancestorIds.length
        || expected.some(function (id, position) { return id !== node.ancestorIds[position]; })) {
        throw new Error('分类祖先路径不闭合');
      }
      if (node.parentId) childrenById[node.parentId].push(node.id);
      else rootsByFacet[node.facet].push(node.id);
      node.ancestorIds.forEach(function (id) { descendantsById[id].push(node.id); });
    });
    function nodes(ids) { return (ids || []).map(function (id) { return byId[id]; }); }
    var graph = {
      registrySha256: text(snapshot.registrySha256), registryVersion: text(snapshot.registryVersion),
      byId: byId, childrenById: childrenById, rootsByFacet: rootsByFacet, descendantsById: descendantsById,
      facets: Object.keys(facetLabels).map(function (id) { return { id: id, label: facetLabels[id] }; }),
      path: function (id) { return byId[id] ? nodes(byId[id].ancestorIds.concat(id)) : []; },
      children: function (id) { return nodes(childrenById[id]); },
      descendants: function (id) { return nodes(descendantsById[id]); },
      search: function (query) {
        var needle = normalized(query);
        return Object.values(byId).filter(function (node) {
          return isActive(node) && [node.id, node.zh, node.en].concat(node.aliases)
            .some(function (label) { return normalized(label).includes(needle); });
        });
      }
    };
    var versions = Object.create(null);
    // 有版本目录时只读取当时保存的词表，显示副本不能覆盖同源的原快照。
    if (!catalog && graph.registrySha256) versions[graph.registrySha256] = graph;
    graph.hasVersionCatalog = !!catalog;
    if (catalog) {
      if (![VERSIONS_CONTRACT, LEGACY_VERSIONS_CONTRACT].includes(catalog.contract) || !Array.isArray(catalog.snapshots)
        || catalog.currentSha256 !== graph.registrySha256 || !catalog.snapshots.length) throw new Error('分类版本目录非法');
      var seenVersions = new Set();
      catalog.snapshots.forEach(function (version) {
        var sha = version && version.registrySha256;
        if (!/^[a-f0-9]{64}$/.test(sha || '') || seenVersions.has(sha)) throw new Error('分类版本重复或无效');
        seenVersions.add(sha);
        if (catalog.contract === VERSIONS_CONTRACT && ![SNAPSHOT_CONTRACT, LEGACY_SNAPSHOT_CONTRACT].includes(version.contract)) {
          throw new Error('当时保存的词表快照格式不受支持。');
        }
        var historical = createRegistry(version);
        var currentContentMatches = snapshot.contract === SNAPSHOT_CONTRACT || catalog.contract === VERSIONS_CONTRACT
          ? sameSnapshotContent(snapshot, version)
          : historical.registryVersion === graph.registryVersion
            && JSON.stringify(Object.values(historical.byId)) === JSON.stringify(Object.values(graph.byId));
        if (sha === graph.registrySha256 && !currentContentMatches) {
          throw new Error('分类当前版本与目录快照不一致');
        }
        Object.values(historical.byId).forEach(function (node) {
          if (graph.byId[node.id] && graph.byId[node.id].facet !== node.facet) throw new Error('稳定分类标识跨版本改变分面');
        });
        versions[sha] = historical;
      });
      if (!seenVersions.has(catalog.currentSha256)) throw new Error('分类版本目录缺少当前版本');
    }
    graph.versions = versions;
    graph.resolveRecord = function (record) {
      var tags = readTagFields(record);
      var sha = text(tags.tagCatalogSha256);
      var source = sha ? versions[sha] : !catalog ? graph : null;
      var result = { status: source ? 'verified' : sha ? 'unknown-version' : 'unbound-version',
        registrySha256: sha, registryVersion: source ? source.registryVersion : '', concepts: [] };
      // 暂缓发布的标签记录不能回退到旧的扁平分类。
      if (tags.tagPublicationStatus === 'withheld') {
        result.status = 'withheld'; return result;
      }
      if (![CONTRACT, LEGACY_CONTRACT].includes(tags.tagContract) || !Array.isArray(tags.tagConcepts)) {
        result.status = 'legacy'; return result;
      }
      if (!source) return result;
      result.concepts = tags.tagConcepts.filter(function (concept) {
        var node = concept && source.byId[concept.id];
        var current = concept && graph.byId[concept.id];
        return node && current && isActive(node) && isActive(current) && node.facet === current.facet
          && concept.facet === node.facet && concept.label === node.zh;
      }).map(function (concept) { return source.byId[concept.id]; });
      if (tags.tagClassificationContract) {
        var role = record.primaryResearchRole;
        var selected = new Set(result.concepts.map(function (node) { return node.id; }));
        var roleNode = role && source.byId[role.conceptId];
        var isV3 = tags.tagClassificationContract === V3_CONTRACT;
        var isQualified1028 = tags.tagClassificationContract === QUALIFIED_CONTRACT && record.paperId === 'conference:icassp:2026:icassp-arnumber:11461028' && tags.tagCatalogSha256 === '910a94021b085a190abcd5fd9603af3240160f9417293d5a90158bc4ef900d30' && tags.tagProofSha256 === '03beb37ae2df8f7f48850f935cb274a9b0c75eebde483e9c1d6c51a5cffaeb20' && tags.tagEvidenceContract === QUALIFIED_CONTRACT && tags.tagEvidenceType === 'source-bound-independent-review-qualification';
        var mechanism = isV3 && record.researchType === 'engineering' && role && role.kind === 'method';
        var allowedFacets = isV3 && record.researchType === 'engineering' ? ['task', 'method'] : roleFacets[record.researchType];
        var v2 = (tags.tagClassificationContract === V2_CONTRACT || isV3 || isQualified1028)
          && (isQualified1028 || (isV3 ? ((tags.tagEvidenceType === 'source-only-taxonomy-v3' && tags.tagEvidenceContract === 'historical-source-taxonomy-supplement-v3') || (tags.tagEvidenceType === 'source-bound-current-page-fullsite-taxonomy-v3' && tags.tagEvidenceContract === 'fullsite-source-taxonomy-audit-supplement-v1')) : ((tags.tagEvidenceType === 'source-only-taxonomy-v2' && tags.tagEvidenceContract === 'historical-source-taxonomy-supplement-v2')
            || (tags.tagEvidenceType === 'controlled-current-page-source-taxonomy-v2' && tags.tagEvidenceContract === 'historical-current-page-source-taxonomy-supplement-v2'))))
          && ['paper-taxonomy-v1', 'paper-taxonomy-v2'].includes(source.registryVersion)
          && own(roleFacets, record.researchType) && own(domainLabels, record.domainScope)
          && roleNode && selected.has(roleNode.id) && allowedFacets.includes(role.kind)
          && role.kind === roleNode.facet && role.label === roleNode.zh
          && result.concepts.length === tags.tagConcepts.length
          && selected.size === result.concepts.length && selected.size <= 5
          && !result.concepts.some(function (node) { return node.ancestorIds.some(function (id) { return selected.has(id); }); });
        if (v2 && record.methodNotApplicable === true) {
          v2 = ['position', 'experience'].includes(record.researchType)
            && !record.primaryMethodId && !text(record.method) && text(record.methodNotApplicableReason).length >= 20
            && !result.concepts.some(function (node) { return node.facet === 'method'; });
        } else if (v2) {
          var method = source.byId[record.primaryMethodId];
          v2 = record.methodNotApplicable === false && method && method.facet === 'method'
            && selected.has(method.id) && !text(record.methodNotApplicableReason) && selected.size >= (mechanism ? 1 : 2);
          if (v2 && mechanism) v2 = record.primaryMethodId === role.conceptId && !record.primaryTaskId && !text(record.task) && !record.primaryScientificTopicId;
        }
        if (v2 && record.researchType === 'engineering' && !mechanism) v2 = record.primaryTaskId === role.conceptId;
        if (v2 && record.researchType !== 'engineering') v2 = !record.primaryTaskId && !text(record.task);
        if (v2 && record.researchType === 'science') v2 = record.primaryScientificTopicId === role.conceptId;
        if (v2 && record.researchType !== 'science') v2 = !record.primaryScientificTopicId;
        if (!v2) { result.status = 'invalid-roles'; result.concepts = []; }
      }
      return result;
    };
    // 先核原签发分类，再按当前分类树导航；原标签、角色与祖先证据保持原签发版本。
    graph.navigationConcepts = function (record) {
      var resolved = graph.resolveRecord(record);
      if (resolved.status !== 'verified') return [];
      return resolved.concepts.map(function (issued) {
        var current = graph.byId[issued.id];
        return Object.assign({}, current, { issuedLabel: issued.zh });
      });
    };
    return graph;
  }

  function arxivBase(value) {
    var id = text(value);
    return /^([0-9]{4}\.[0-9]{4,5}|[a-z][a-z0-9.-]*\/[0-9]{7})(v[1-9][0-9]*)?$/.test(id)
      ? id.replace(/v[1-9][0-9]*$/, '') : '';
  }

  function identity(record) {
    // 依据网址推测的标识和未核验身份不能将不同论文的页面合并。
    var verified = record.identityStatus === 'verified';
    var arxivId = verified ? arxivBase(record.arxivId) : '';
    var paperId = verified ? text(record.paperId) : '';
    if (arxivId) return { key: 'arxiv:' + arxivId, paperId: paperId || 'arxiv:' + arxivId,
      arxivId: arxivId, identityVerified: true };
    if (paperId && /^[a-z][a-z0-9_-]*:[^\s\u0000-\u001f\u007f]+$/.test(paperId)) {
      return { key: paperId, paperId: paperId, arxivId: '', identityVerified: true };
    }
    return { key: 'page:' + text(record.permalink), paperId: '', arxivId: '', identityVerified: false };
  }

  function groupPapers(records, graph) {
    if (!graph || !graph.byId) throw new Error('需要有效分类目录');
    if (!Array.isArray(records)) throw new Error('论文索引必须是数组');
    var groups = new Map();
    var seenUrls = new Set();
    records.forEach(function (record) {
      if (!record || record.pageType !== 'paper' || !text(record.permalink) || seenUrls.has(record.permalink)) return;
      seenUrls.add(record.permalink);
      var id = identity(record);
      var group = groups.get(id.key);
      if (!group) {
        group = Object.assign({}, id, { articles: [], classifications: [], conceptIds: [], primaryTaskIds: [], primaryMethodIds: [] });
        groups.set(id.key, group);
      }
      group.articles.push(record);
      var resolved = graph.resolveRecord(record);
      var classification = { conceptIds: [], primaryTaskIds: [], primaryMethodIds: [],
        primaryRoleIdsByFacet: Object.create(null), researchType: '', domainScope: '',
        ancestorIdsByConcept: Object.create(null), navigationAncestorIdsByConcept: Object.create(null), labelsByConcept: Object.create(null),
        registrySha256: resolved.registrySha256, registryVersion: resolved.registryVersion, status: resolved.status };
      group.classifications.push(classification);
      // 旧页面的普通标签和未核验标签记录，不能因为进入搜索索引就成为已核验分类。
      var direct = resolved.concepts.map(function (node) {
        classification.ancestorIdsByConcept[node.id] = node.ancestorIds.slice();
        classification.navigationAncestorIdsByConcept[node.id] = graph.byId[node.id].ancestorIds.slice();
        classification.labelsByConcept[node.id] = node.zh;
        return node.id;
      });
      classification.conceptIds = Array.from(new Set(direct));
      direct.forEach(function (conceptId) {
        if (!group.conceptIds.includes(conceptId)) group.conceptIds.push(conceptId);
      });
      [['primaryTaskId', 'primaryTaskIds', 'task'], ['primaryMethodId', 'primaryMethodIds', 'method']]
        .forEach(function (field) {
          var primaryId = record[field[0]];
          if (direct.includes(primaryId) && graph.byId[primaryId].facet === field[2]) {
            classification[field[1]].push(primaryId);
            if (!group[field[1]].includes(primaryId)) group[field[1]].push(primaryId);
          }
        });
      if (resolved.status === 'verified' && [V2_CONTRACT, V3_CONTRACT, QUALIFIED_CONTRACT].includes(readTagFields(record).tagClassificationContract) && resolved.concepts.length) {
        classification.researchType = record.researchType;
        classification.domainScope = record.domainScope;
        var primaryRole = record.primaryResearchRole;
        classification.primaryRoleIdsByFacet[primaryRole.kind] = [primaryRole.conceptId];
      }
    });
    return Array.from(groups.values());
  }

  function selectionIds(group, facet, role, graph) {
    if (role === 'primary' && group.primaryRoleIdsByFacet && group.primaryRoleIdsByFacet[facet]) return group.primaryRoleIdsByFacet[facet];
    if (role === 'primary' && facet === 'task') return group.primaryTaskIds;
    if (role === 'primary' && facet === 'method') return group.primaryMethodIds;
    if (role === 'primary' && ['scientific_topic', 'research_focus', 'artifact'].includes(facet)) return [];
    return group.conceptIds.filter(function (id) { return graph.byId[id] && graph.byId[id].facet === facet; });
  }

  function validatedFilters(filters, graph) {
    var value = filters || {};
    var scope = value.scope || 'subtree';
    var role = value.role || 'any';
    if (!['direct', 'subtree'].includes(scope) || !['primary', 'any'].includes(role)) throw new Error('分类筛选范围非法');
    var facets = value.facets || {};
    if (!facets || typeof facets !== 'object' || Array.isArray(facets)) throw new Error('分类筛选必须按分面提供');
    Object.keys(facets).forEach(function (facet) {
      if (!own(facetLabels, facet) || !Array.isArray(facets[facet])) throw new Error('分类分面非法');
      facets[facet].forEach(function (id) {
        if (!graph.byId[id] || graph.byId[id].facet !== facet || !isActive(graph.byId[id])) throw new Error('分类筛选包含未知方向');
      });
    });
    var domainScope = value.domainScope || 'all', researchType = value.researchType || 'all';
    if (!['all', 'unclassified'].includes(domainScope) && !own(domainLabels, domainScope)) throw new Error('研究范围筛选非法');
    if (!['all', 'unclassified'].includes(researchType) && !own(researchTypeLabels, researchType)) throw new Error('研究类型筛选非法');
    return { scope: scope, role: role, facets: facets, domainScope: domainScope, researchType: researchType };
  }

  function matchingClassifications(group, selection, graph) {
    // 同篇论文的多份签发导读可能不一致；必须有一份导读独立满足全部条件，不能拼接不同导读的标签。
    return (group.classifications || []).filter(function (classification) {
      if (selection.domainScope !== 'all'
        && (selection.domainScope === 'unclassified' ? !!classification.domainScope : classification.domainScope !== selection.domainScope)) return false;
      if (selection.researchType !== 'all'
        && (selection.researchType === 'unclassified' ? !!classification.researchType : classification.researchType !== selection.researchType)) return false;
      return Object.keys(selection.facets).every(function (facet) {
        var chosen = selection.facets[facet];
        if (!chosen.length) return true;
        var ids = selectionIds(classification, facet, selection.role, graph);
        return chosen.some(function (target) {
          return ids.some(function (id) {
            return id === target || (selection.scope === 'subtree' && (classification.navigationAncestorIdsByConcept[id] || []).includes(target));
          });
        });
      });
    });
  }

  function query(groups, filters, graph) {
    var selection = validatedFilters(filters, graph);
    return groups.filter(function (group) { return matchingClassifications(group, selection, graph).length > 0; });
  }

  function counts(groups, graph, filters) {
    var selection = validatedFilters(filters, graph);
    var selected = groups.map(function (group) { return matchingClassifications(group, selection, graph); })
      .filter(function (classifications) { return classifications.length > 0; });
    var directCounts = Object.create(null);
    var subtreeCounts = Object.create(null);
    selected.forEach(function (classifications) {
      var directIds = new Set();
      var subtreeIds = new Set();
      Object.keys(facetLabels).forEach(function (facet) {
        classifications.forEach(function (classification) {
          selectionIds(classification, facet, selection.role, graph).forEach(function (id) {
            directIds.add(id);
            subtreeIds.add(id);
            (classification.navigationAncestorIdsByConcept[id] || []).forEach(function (ancestor) { subtreeIds.add(ancestor); });
          });
        });
      });
      directIds.forEach(function (id) { directCounts[id] = (directCounts[id] || 0) + 1; });
      subtreeIds.forEach(function (id) { subtreeCounts[id] = (subtreeCounts[id] || 0) + 1; });
    });
    return { total: selected.length, concepts: Object.values(graph.byId).filter(isActive).map(function (node) {
      return { id: node.id, direct: directCounts[node.id] || 0, subtree: subtreeCounts[node.id] || 0 };
    }) };
  }

  function primaryRoleLabel(record) {
    return record && readTagFields(record).tagClassificationContract === V3_CONTRACT && record.researchType === 'engineering' && record.primaryResearchRole && record.primaryResearchRole.kind === 'method'
      ? '主要研究机制' : roleLabels[record && record.primaryResearchRole && record.primaryResearchRole.kind] || '主要研究角色';
  }
  return { contract: CONTRACT, legacyContract: LEGACY_CONTRACT, v2Contract: V2_CONTRACT, v3Contract: V3_CONTRACT, qualified1028Contract: QUALIFIED_CONTRACT, primaryRoleLabel: primaryRoleLabel, facetLabels: facetLabels, researchTypeLabels: researchTypeLabels,
    domainLabels: domainLabels, roleLabels: roleLabels, isActive: isActive, readerScopeNote: readerScopeNote,
    createRegistry: createRegistry, buildRegistry: createRegistry, loadDisplayAssets: loadDisplayAssets, arxivBase: arxivBase,
    readTagFields: readTagFields, identity: identity, groupPapers: groupPapers, query: query, counts: counts };
}));
