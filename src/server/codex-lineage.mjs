// Read only explicit thread relationships. A model's prose is never ancestry.
export function codexThreadLink(record, sessionId, cwd) {
  const text = value => typeof value === "string" && value.trim() ? value : null;
  let child, parent, details;
  if (record?.type === "session_meta") {
    details = record.payload;
    const spawn = details?.source?.subagent?.thread_spawn;
    const direct = text(details?.parent_thread_id);
    const inherited = text(spawn?.parent_thread_id);
    if (direct && inherited && direct !== inherited) return null;
    parent = direct ?? inherited;
    child = text(details?.id) ?? text(sessionId);
    details = { ...spawn, ...details };
  } else if (record?.type === "event_msg") {
    const payload = record.payload;
    details = payload?.type === "sub_agent_activity" ? payload
      : payload?.item?.type === "SubAgentActivity" ? payload.item : null;
    if (details?.kind !== "started") return null;
    child = text(details.agent_thread_id);
    parent = text(sessionId);
  }
  if (!child || !parent || child === parent) return null;
  return {
    hook_event_name: "CodexThreadLinked", provider: "codex",
    session_id: child, parent_session_id: parent, cwd,
    agent_nickname: text(details?.agent_nickname),
    agent_role: text(details?.agent_role) ?? text(details?.agent_type),
  };
}
