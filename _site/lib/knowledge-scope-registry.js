const fs = require('fs');
const path = require('path');

const SCOPE_SCHEMA = 'project-knowledge/knowledge-scopes/v1';

function stablePart(value) {
  return encodeURIComponent(String(value || '').trim().toLowerCase()).replace(/%/g, '_');
}

function defaultPrimarySpaceId(slug, project = {}) {
  if (project.primarySpaceId) return String(project.primarySpaceId);
  if (project.knowledgeMode === 'team' && project.kbId) {
    const store = project.kbStoreId || project.kbStoreFullName || 'team';
    return `team:${stablePart(store)}:${stablePart(project.kbId)}`;
  }
  return `project:${stablePart(slug)}`;
}

function defaultRegistry() {
  return { schema: SCOPE_SCHEMA, spaces: {}, projectBindings: {}, updatedAt: '' };
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map(value => String(value).trim()).filter(Boolean)));
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return defaultRegistry();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : defaultRegistry();
  } catch {
    return defaultRegistry();
  }
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

function comparable(value) {
  const copy = JSON.parse(JSON.stringify(value));
  delete copy.updatedAt;
  return JSON.stringify(copy);
}

class KnowledgeScopeRegistry {
  constructor(options = {}) {
    if (!options.filePath) throw new Error('filePath is required');
    this.filePath = path.resolve(options.filePath);
  }

  read() {
    const raw = readJson(this.filePath);
    return {
      schema: SCOPE_SCHEMA,
      spaces: raw.spaces && typeof raw.spaces === 'object' ? raw.spaces : {},
      projectBindings: raw.projectBindings && typeof raw.projectBindings === 'object' ? raw.projectBindings : {},
      updatedAt: String(raw.updatedAt || ''),
    };
  }

  write(registry) {
    const next = { ...registry, schema: SCOPE_SCHEMA, updatedAt: new Date().toISOString() };
    atomicWrite(this.filePath, next);
    return next;
  }

  synchronizeProjects(projects = {}) {
    const current = this.read();
    const next = JSON.parse(JSON.stringify(current));
    const activeSlugs = new Set(Object.keys(projects));

    for (const slug of Object.keys(next.projectBindings)) {
      if (!activeSlugs.has(slug)) delete next.projectBindings[slug];
    }
    for (const space of Object.values(next.spaces)) {
      space.projectSlugs = uniqueStrings(space.projectSlugs).filter(slug => activeSlugs.has(slug));
      if (!space.projectSlugs.length && space.kind !== 'shared') space.enabled = false;
    }

    for (const [slug, project] of Object.entries(projects)) {
      const primarySpaceId = defaultPrimarySpaceId(slug, project);
      const prior = next.projectBindings[slug] || {};
      const relatedProjectSlugs = uniqueStrings(prior.relatedProjectSlugs)
        .filter(candidate => candidate !== slug && activeSlugs.has(candidate));
      const sharedSpaceIds = uniqueStrings(prior.sharedSpaceIds)
        .filter(spaceId => next.spaces[spaceId] && next.spaces[spaceId].enabled !== false);
      next.projectBindings[slug] = {
        projectSlug: slug,
        primarySpaceId,
        relatedProjectSlugs,
        sharedSpaceIds,
      };
      const priorSpace = next.spaces[primarySpaceId] || {};
      next.spaces[primarySpaceId] = {
        ...priorSpace,
        id: primarySpaceId,
        kind: project.knowledgeMode === 'team' ? 'team' : (priorSpace.kind || 'project'),
        displayName: project.kbDisplayName || project.displayName || slug,
        enabled: project.enabled !== false,
        projectSlugs: uniqueStrings([...(priorSpace.projectSlugs || []), slug]),
        kbId: project.kbId || priorSpace.kbId || '',
        kbStoreId: project.kbStoreId || priorSpace.kbStoreId || '',
      };
    }

    if (comparable(current) !== comparable(next)) return this.write(next);
    return current;
  }

  setProjectRelations(projects, slug, relatedProjectSlugs, options = {}) {
    if (!projects[slug]) throw new Error(`project not found: ${slug}`);
    let registry = this.synchronizeProjects(projects);
    const related = uniqueStrings(relatedProjectSlugs).filter(item => item !== slug);
    for (const candidate of related) {
      if (!projects[candidate] || projects[candidate].enabled === false) throw new Error(`related project is unavailable: ${candidate}`);
    }
    registry = JSON.parse(JSON.stringify(registry));
    registry.projectBindings[slug].relatedProjectSlugs = related;
    if (options.bidirectional !== false) {
      for (const candidate of Object.keys(projects)) {
        if (candidate === slug || !registry.projectBindings[candidate]) continue;
        const links = new Set(registry.projectBindings[candidate].relatedProjectSlugs || []);
        if (related.includes(candidate)) links.add(slug);
        else links.delete(slug);
        registry.projectBindings[candidate].relatedProjectSlugs = Array.from(links).sort();
      }
    }
    return this.write(registry);
  }

  resolveProjectScope(projects, slug) {
    const registry = this.synchronizeProjects(projects);
    const binding = registry.projectBindings[slug];
    if (!binding) throw new Error(`project not found: ${slug}`);
    const weighted = new Map([[binding.primarySpaceId, { spaceId: binding.primarySpaceId, weight: 1, reason: 'primary', projectSlug: slug }]]);
    for (const sharedId of binding.sharedSpaceIds || []) {
      if (registry.spaces[sharedId]?.enabled === false) continue;
      weighted.set(sharedId, { spaceId: sharedId, weight: 0.95, reason: 'shared', projectSlug: '' });
    }
    for (const relatedSlug of binding.relatedProjectSlugs || []) {
      const related = registry.projectBindings[relatedSlug];
      if (!related || projects[relatedSlug]?.enabled === false) continue;
      const current = weighted.get(related.primarySpaceId);
      if (!current || current.weight < 0.88) {
        weighted.set(related.primarySpaceId, { spaceId: related.primarySpaceId, weight: 0.88, reason: 'related', projectSlug: relatedSlug });
      }
    }
    return {
      projectSlug: slug,
      primarySpaceId: binding.primarySpaceId,
      spaces: Array.from(weighted.values()),
      // Deliberately no transitive expansion: only links selected on this project.
      transitive: false,
    };
  }
}

module.exports = { KnowledgeScopeRegistry, SCOPE_SCHEMA, defaultPrimarySpaceId };
