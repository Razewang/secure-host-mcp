const TERMINAL_QUERY_RESPONSES = new Map([
  ["\u001b[c", "\u001b[?1;0c"],
  ["\u001b[6n", "\u001b[1;1R"]
]);

const QUERIES = [...TERMINAL_QUERY_RESPONSES.keys()];

export class TerminalQueryResponder {
  private pending = "";

  push(data: string): string[] {
    const input = this.pending + data;
    this.pending = "";
    const responses: string[] = [];
    let cursor = 0;

    while (cursor < input.length) {
      const escape = input.indexOf("\u001b", cursor);
      if (escape < 0) break;
      const tail = input.slice(escape);
      const exact = QUERIES.find((query) => tail.startsWith(query));
      if (exact) {
        responses.push(TERMINAL_QUERY_RESPONSES.get(exact)!);
        cursor = escape + exact.length;
        continue;
      }
      const partial = QUERIES.find((query) => query.startsWith(tail));
      if (partial) {
        this.pending = tail;
        break;
      }
      cursor = escape + 1;
    }
    return responses;
  }
}
