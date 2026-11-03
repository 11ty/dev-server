// Opens the live reload event stream with `fetch` (Node’s `EventSource` is behind a flag).
export async function openEventStream(url, init = {}) {
  let controller = new AbortController();
  let res = await fetch(url, { ...init, signal: controller.signal });
  let reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  async function readEvent() {
    while(true) {
      let end = buffer.indexOf("\n\n");
      if(end > -1) {
        let block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let id;
        let data = [];
        for(let line of block.split("\n")) {
          if(line.startsWith("id: ")) {
            id = line.slice(4);
          } else if(line.startsWith("data: ")) {
            data.push(line.slice(6));
          }
        }
        if(data.length > 0) {
          return { id, message: JSON.parse(data.join("\n")) };
        }
        continue;
      }

      let { value, done } = await reader.read();
      if(done) {
        return;
      }
      buffer += value;
    }
  }

  return {
    res,
    // Resolves with the next message matching `type` (and its event id), or `undefined` when the stream ends.
    async next(type) {
      let event;
      while((event = await readEvent())) {
        if(!type || event.message.type === type) {
          return Object.assign(event.message, { eventId: event.id });
        }
      }
    },
    close() {
      controller.abort();
    },
  };
}
