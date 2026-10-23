// The forge panels read and never write. Every request a
// GitHub or GitLab client sends is a GET, or a GraphQL document posted to the
// forge's GraphQL endpoint that only queries: no mutation, no subscription.
//
// The client suites record what this answers for each request their fake
// fetch is sent, and check after every case that nothing was recorded. A
// throw inside the fake fetch would not do: the client turns it into a forge
// failure, which a case that expects a failure would pass with.

/** Why a request is not a read, or null when it is one. */
export function notARead(url: string, method: string, query: string): string | null {
  if (method === "GET") return null;
  if (method !== "POST" || !/\/graphql$/.test(new URL(url).pathname)) return `${method} ${url}`;
  const doc = query.replace(/#[^\n]*/g, "");
  if (!/^\s*(?:query\b|\{)/.test(doc) || /\b(?:mutation|subscription)\b/.test(doc)) return `not a query: ${doc.trim().slice(0, 80)}`;
  return null;
}
