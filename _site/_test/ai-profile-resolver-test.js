// _site/_test/ai-profile-resolver-test.js
//
// Tests for the shared effective AI profile resolver. The resolver is the
// single source of truth for "which AI profile does this project use right
// now" — replacing the inconsistent fallback logic that used to live in
// Workbench start-session / send-input, the analyzer, the CommitReconciler,
// and import default assignment.
//
// Resolution order (per T01):
//   1. projectConfig.aiProfileId when usable
//   2. settings.ai.defaultProfileId when usable
//   3. first usable configured profile in stable configured order
//   4. otherwise AI_PROFILE_REQUIRED

const assert = require('assert');
const { resolveEffectiveAiProfile, isUsable, profileById } = require('../lib/ai-profile-resolver');

const PROFILE_A = { id: 'profile-a', name: 'A', enabled: true, vendor: 'anthropic', model: 'm' };
const PROFILE_B = { id: 'profile-b', name: 'B', enabled: true, vendor: 'anthropic', model: 'm' };
const PROFILE_DISABLED = { id: 'profile-disabled', name: 'Disabled', enabled: false, vendor: 'anthropic', model: 'm' };
const PROFILE_ENABLED_UNDEFINED = { id: 'profile-default-enabled', name: 'DefaultEnabled', vendor: 'anthropic', model: 'm' };

function settings(profiles, defaultProfileId) {
  return { ai: { schema: 'ai-profiles/v1', profiles, defaultProfileId: defaultProfileId || null } };
}

(async () => {
  // ---- Case 1: explicit project profile is preferred ----
  {
    const s = settings([PROFILE_A, PROFILE_B], 'profile-b');
    const r = resolveEffectiveAiProfile(s, { aiProfileId: 'profile-a' });
    assert.strictEqual(r.source, 'project');
    assert.strictEqual(r.profileId, 'profile-a');
    assert.strictEqual(r.profile.id, 'profile-a');
  }

  // ---- Case 2: default profile fallback when project has none ----
  {
    const s = settings([PROFILE_A, PROFILE_B], 'profile-b');
    const r = resolveEffectiveAiProfile(s, { aiProfileId: null });
    assert.strictEqual(r.source, 'default');
    assert.strictEqual(r.profileId, 'profile-b');
  }

  // ---- Case 3: first-usable fallback when default is missing/disabled ----
  {
    const s = settings([PROFILE_DISABLED, PROFILE_A, PROFILE_B], 'profile-disabled');
    const r = resolveEffectiveAiProfile(s, { aiProfileId: null });
    assert.strictEqual(r.source, 'first-usable');
    assert.strictEqual(r.profileId, 'profile-a');
  }

  // ---- Case 4: stale project profile id falls back safely ----
  {
    const s = settings([PROFILE_A, PROFILE_B], 'profile-b');
    const r = resolveEffectiveAiProfile(s, { aiProfileId: 'profile-deleted' });
    assert.strictEqual(r.source, 'default');
    assert.strictEqual(r.profileId, 'profile-b');
  }

  // ---- Case 5: disabled project profile falls back to default ----
  {
    const s = settings([PROFILE_DISABLED, PROFILE_B], 'profile-b');
    const r = resolveEffectiveAiProfile(s, { aiProfileId: 'profile-disabled' });
    assert.strictEqual(r.source, 'default');
    assert.strictEqual(r.profileId, 'profile-b');
  }

  // ---- Case 6: no usable profile produces one clear error ----
  {
    const s = settings([PROFILE_DISABLED], null);
    let threw = null;
    try { resolveEffectiveAiProfile(s, { aiProfileId: null }); }
    catch (error) { threw = error; }
    assert(threw, 'resolver must throw when no usable profile exists');
    assert.strictEqual(threw.code, 'AI_PROFILE_REQUIRED');
    assert.strictEqual(threw.status, 409);
    assert(threw.details && typeof threw.details.hint === 'string');
  }

  // ---- Case 7: enabled=undefined (legacy profiles) is treated as usable ----
  {
    const s = settings([PROFILE_ENABLED_UNDEFINED], 'profile-default-enabled');
    const r = resolveEffectiveAiProfile(s, { aiProfileId: null });
    assert.strictEqual(r.source, 'default');
    assert.strictEqual(r.profileId, 'profile-default-enabled');
  }

  // ---- Case 8: empty settings produces AI_PROFILE_REQUIRED ----
  {
    let threw = null;
    try { resolveEffectiveAiProfile({ ai: { profiles: [] } }, { aiProfileId: null }); }
    catch (error) { threw = error; }
    assert(threw, 'empty settings must throw AI_PROFILE_REQUIRED');
    assert.strictEqual(threw.code, 'AI_PROFILE_REQUIRED');
  }

  // ---- Case 9: null/undefined inputs are tolerated ----
  {
    const r = resolveEffectiveAiProfile({ ai: { profiles: [PROFILE_A] } }, null);
    assert.strictEqual(r.source, 'first-usable');
    assert.strictEqual(r.profileId, 'profile-a');
  }

  // ---- Case 10: isUsable + profileById helpers ----
  {
    assert.strictEqual(isUsable(PROFILE_A), true);
    assert.strictEqual(isUsable(PROFILE_DISABLED), false);
    assert.strictEqual(isUsable(null), false);
    const s = settings([PROFILE_A, PROFILE_B]);
    assert.strictEqual(profileById(s, 'profile-a').id, 'profile-a');
    assert.strictEqual(profileById(s, 'profile-unknown'), null);
    assert.strictEqual(profileById(s, ''), null);
  }

  // ---- Case 11: deterministic first-usable order ----
  {
    const s = settings([PROFILE_A, PROFILE_B], null);
    const r1 = resolveEffectiveAiProfile(s, { aiProfileId: null });
    const r2 = resolveEffectiveAiProfile(s, { aiProfileId: null });
    assert.strictEqual(r1.profileId, 'profile-a');
    assert.strictEqual(r2.profileId, 'profile-a');
  }

  // ---- Case 12: default profile that is enabled=undefined still wins over first-usable ----
  {
    const s = settings([PROFILE_A, PROFILE_ENABLED_UNDEFINED], 'profile-default-enabled');
    const r = resolveEffectiveAiProfile(s, { aiProfileId: null });
    assert.strictEqual(r.source, 'default');
    assert.strictEqual(r.profileId, 'profile-default-enabled');
  }

  console.log('ai-profile-resolver-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
