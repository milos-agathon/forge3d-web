/** Pure reconciliation. Discovery cannot confer, revoke, or rebind acceptance. */
export function contractIdentity(target) {
  return Object.fromEntries(["id", "capabilityId", "kind", "contract", "owner"].map(key => [key, target[key]]));
}
export function reconcileParity(discovered, records) {
  const byId = new Map();
  for (const record of records) {
    if (byId.has(record.identity.id)) throw new Error(`Duplicate acceptance identity: ${record.identity.id}`);
    byId.set(record.identity.id, record);
  }
  const seen = new Set();
  const targets = discovered.map(target => {
    if (seen.has(target.id)) throw new Error(`Duplicate discovered identity: ${target.id}`);
    seen.add(target.id);
    const record = byId.get(target.id);
    if (!record) throw new Error(`Unreviewed parity contract: ${target.id}`);
    if (JSON.stringify(contractIdentity(target)) !== JSON.stringify(contractIdentity(record.identity))) {
      throw new Error(`Stale acceptance binding: ${target.id}`);
    }
    if (target.status !== record.status) throw new Error(`Unreviewed parity promotion/demotion: ${target.id}`);
    for (const key of Object.keys(record.acceptance)) {
      if (key in record.identity || key === "status") throw new Error(`Acceptance cannot replace identity: ${target.id}`);
    }
    const { status, ...identity } = target;
    return { ...identity, ...structuredClone(record.acceptance) };
  });
  for (const id of byId.keys()) if (!seen.has(id)) throw new Error(`Stale acceptance contract removed or renamed: ${id}`);
  return targets;
}
export function verifyHistoricalBindings(manifest, acceptance) {
  for (const key of ["baselineLayers", "counts"]) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(acceptance[key])) throw new Error(`Historical parity ${key} changed`);
  }
}

export function reconcileCapabilityEvidence(rows, records) {
  return rows.map(row => {
    const previous=records.find(record=>record.id===row.id);
    if (!previous || ["targetId","status","requiredWebOutcome"].some(key=>row[key]!==previous[key])) throw new Error(`Stale capability acceptance: ${row.id}`);
    return {...row, requiredTests:structuredClone(previous.requiredTests),acceptance:structuredClone(previous.acceptance)};
  });
}
export function retainHistoricalSources(discovered, accepted) {
  if (discovered.length !== accepted.length) throw new Error("Historical inventory denominator changed");
  const previous=new Map(accepted.map(record=>[record.id,record]));
  return discovered.map(record=>{
    const old=previous.get(record.id);
    if (!old || record.kind!==old.kind || record.source.ref!==old.source.ref || record.source.path!==old.source.path) throw new Error(`Stale historical source binding: ${record.id}`);
    // Discovery may use a newer working plan; it cannot rewrite the accepted source snapshot.
    return {...record,source:structuredClone(old.source)};
  });
}
