const crypto = require('crypto');
const { DomainError, validateProjectId } = require('./contracts');
const { ConversationStore } = require('./conversation-store');
const { readDevelopmentEvents } = require('./conversation-exclusions');

function localDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function validDate(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`))) {
    throw new DomainError('INVALID_ARGUMENT', 'date must be YYYY-MM-DD.');
  }
  return date;
}

function fingerprint(projectId, date) {
  return crypto.createHash('sha256').update(`${projectId}\n${date}`, 'utf8').digest('hex');
}

function encodeCursor(projectId, date, beforeKey) {
  return Buffer.from(JSON.stringify({ v: 1, fingerprint: fingerprint(projectId, date), beforeKey }), 'utf8').toString('base64url');
}

function decodeCursor(value, projectId, date) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!cursor || cursor.v !== 1 || cursor.fingerprint !== fingerprint(projectId, date) || typeof cursor.beforeKey !== 'string') throw new Error('mismatch');
    return cursor;
  } catch (error) {
    throw new DomainError('INVALID_ARGUMENT', 'Conversation cursor is invalid for this project/date query.', { status: 409, cause: error });
  }
}

class ConversationQueryService {
  constructor(options = {}) {
    this.registryStore = options.registryStore;
    this.projectStore = options.projectStore;
    this.conversationStore = options.conversationStore || new ConversationStore(options);
    this.logger = options.logger || null;
  }

  async log(level, event, message, context) {
    try { if (this.logger && typeof this.logger[level] === 'function') await this.logger[level](event, message, context); } catch {
      // Read-only conversation queries do not depend on observer availability.
    }
  }

  listProjects() {
    return this.registryStore.listIds().map(projectId => {
      const config = this.projectStore.readConfig(projectId);
      const state = this.projectStore.readState(projectId);
      return {
        projectId,
        displayName: config.displayName,
        enabled: config.enabled !== false,
        captureStatus: state.conversation && state.conversation.captureStatus || 'unavailable',
      };
    });
  }

  annotations(projectId) {
    const byTurn = new Map();
    for (const snapshot of this.conversationStore.listSnapshots(projectId)) {
      for (const turn of snapshot.turns) {
        const current = byTurn.get(turn.turnId) || [];
        current.push({
          commitSha: snapshot.commitSha,
          shortSha: snapshot.commitSha.slice(0, 7),
          status: turn.bindingKind === 'shared-spanning' ? 'associated' : 'committed',
          bindingKind: turn.bindingKind,
          snapshotHash: snapshot.snapshotHash,
        });
        byTurn.set(turn.turnId, current);
      }
    }
    for (const values of byTurn.values()) values.sort((left, right) => left.commitSha.localeCompare(right.commitSha));
    return byTurn;
  }

  async turns(input = {}) {
    const projectId = validateProjectId(input.projectId);
    if (!this.registryStore.readDisplaySnapshot(projectId)) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found.', { status: 404 });
    const date = validDate(input.date);
    const limit = Math.max(1, Math.min(Number(input.limit || 50), 200));
    const cursor = decodeCursor(input.cursor, projectId, date);
    const groups = new Map();
    for (const event of readDevelopmentEvents(this.conversationStore, projectId)) {
      const turnId = event.turnId || `event:${event.eventId}`;
      let group = groups.get(turnId);
      if (!group) {
        group = { turnId, source: event.source, sessionId: event.sessionId, events: [] };
        groups.set(turnId, group);
      }
      group.events.push(event);
    }
    const annotations = this.annotations(projectId);
    let projected = [...groups.values()].map(group => {
      group.events.sort((left, right) => String(left.capturedAt).localeCompare(String(right.capturedAt)) || left.eventId.localeCompare(right.eventId));
      const first = group.events[0];
      const last = group.events.at(-1);
      const userEvents = group.events.filter(event => event.role === 'user');
      const assistantEvents = group.events.filter(event => event.role === 'assistant');
      const eventDate = localDate((userEvents[0] || first).capturedAt);
      const turnAnnotations = annotations.get(group.turnId) || [];
      const status = turnAnnotations.some(annotation => annotation.status === 'committed')
        ? 'committed'
        : turnAnnotations.length ? 'associated' : 'uncommitted';
      return {
        turnId: group.turnId,
        source: group.source,
        sessionId: group.sessionId,
        date: eventDate,
        startedAt: first.capturedAt,
        updatedAt: last.capturedAt,
        userPrompt: userEvents.map(event => event.content).join('\n\n'),
        assistantReply: assistantEvents.map(event => event.content).join('\n\n'),
        userEventIds: userEvents.map(event => event.eventId),
        assistantEventIds: assistantEvents.map(event => event.eventId),
        annotation: { status, commits: turnAnnotations },
        renderAs: 'plain-text',
        key: `${first.capturedAt}|${group.turnId}`,
      };
    }).filter(turn => turn.date === date)
      .sort((left, right) => right.key.localeCompare(left.key));
    if (cursor) projected = projected.filter(turn => turn.key < cursor.beforeKey);
    const page = projected.slice(0, limit);
    const hasMore = projected.length > page.length;
    const result = {
      ok: true,
      projectId,
      date,
      turns: page.map(({ key, ...turn }) => turn),
      nextCursor: hasMore ? encodeCursor(projectId, date, page.at(-1).key) : null,
      hasMore,
      limit,
    };
    await this.log('debug', 'conversation.turns_queried', 'Development conversation turns were queried.', {
      projectId,
      component: 'conversation-query',
      context: { date, resultCount: result.turns.length, hasMore },
    });
    return result;
  }
}

module.exports = { ConversationQueryService, localDate, validDate, encodeCursor, decodeCursor };
