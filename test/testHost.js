import test from "ava";
import http from "node:http";
import DevServer from "../server.js";
import ipAddress from "../server/ipAddress.js";

const [lanAddress] = ipAddress();

async function startServer(options = {}) {
  let hosts;
  let messages = [];
  let server = new DevServer("test-server", "./test/stubs/", {
    logger: { info: (message) => messages.push(message), log() {}, error() {} },
    messageOnStart: (data) => {
      hosts = data.hosts;
    },
    ...options,
  });
  server.serve(0);
  let port = await server.getPort();
  await server.ready();
  return { server, port, hosts, messages };
}

function isReachable(hostname, port) {
  return new Promise((resolve) => {
    http.get({ hostname, port, path: "/sample" }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    }).on("error", () => resolve(false));
  });
}

for(let serverThread of [true, false]) {
  let mode = serverThread ? "threaded" : "single-threaded";

  test(`Listens on 127.0.0.1 by default (${mode})`, async (t) => {
    let { server, port, hosts } = await startServer({ serverThread });

    t.deepEqual(hosts, [`http://localhost:${port}/`]);
    t.true(await isReachable("127.0.0.1", port));
    t.true(await isReachable("localhost", port));
    if(lanAddress) {
      t.false(await isReachable(lanAddress, port), "not reachable from the network");
    }

    await server.close();
  });

  test(`host 0.0.0.0 with showAllHosts lists reachable network addresses (${mode})`, async (t) => {
    let { server, port, hosts } = await startServer({ serverThread, host: "0.0.0.0", showAllHosts: true });

    t.is(hosts.at(-1), `http://localhost:${port}/`);
    for(let url of hosts) {
      t.true(await isReachable(new URL(url).hostname, port), url);
    }
    if(lanAddress) {
      t.true(hosts.includes(`http://${lanAddress}:${port}/`));
    }

    await server.close();
  });
}

test("showAllHosts alone doesn't allow network access or list network addresses", async (t) => {
  let { server, port, hosts, messages } = await startServer({ showAllHosts: true });

  t.deepEqual(hosts, [`http://localhost:${port}/`]);
  t.true(messages.some((message) => message.includes(`host: "0.0.0.0"`)), "logs a hint");
  if(lanAddress) {
    t.false(await isReachable(lanAddress, port));
  }

  await server.close();
});

test("host 0.0.0.0 lists network addresses by default", async (t) => {
  let { server, port, hosts } = await startServer({ host: "0.0.0.0" });

  t.is(hosts.at(-1), `http://localhost:${port}/`);
  if(lanAddress) {
    t.true(hosts.includes(`http://${lanAddress}:${port}/`));
    t.true(await isReachable(lanAddress, port));
  }

  await server.close();
});

test("host 0.0.0.0 with showAllHosts: false only lists localhost", async (t) => {
  let { server, port, hosts } = await startServer({ host: "0.0.0.0", showAllHosts: false });

  t.deepEqual(hosts, [`http://localhost:${port}/`]);
  if(lanAddress) {
    t.true(await isReachable(lanAddress, port));
  }

  await server.close();
});

test("A non-loopback host is listed instead of localhost", async (t) => {
  if(!lanAddress) {
    t.pass("no network address on this machine");
    return;
  }

  let { server, port, hosts } = await startServer({ host: lanAddress });

  t.deepEqual(hosts, [`http://${lanAddress}:${port}/`]);
  t.true(await isReachable(lanAddress, port));
  t.false(await isReachable("127.0.0.1", port));

  await server.close();
});

for(let serverThread of [true, false]) {
  let mode = serverThread ? "threaded" : "single-threaded";

  test(`Moves to the next port when another server listens on every interface (${mode})`, async (t) => {
    let blocker = http.createServer((req, res) => res.end("BLOCKER"));
    await new Promise((resolve) => blocker.listen(0, "::", resolve));
    let blockedPort = blocker.address().port;

    let server = new DevServer("test-server", "./test/stubs/", {
      serverThread,
      portReassignmentRetryCount: 10,
      logger: { info() {}, log() {}, error() {} },
    });
    server.serve(blockedPort);
    let port = await server.getPort();

    t.not(port, blockedPort);
    t.true(await isReachable("127.0.0.1", port));

    await server.close();
    await new Promise((resolve) => blocker.close(resolve));
  });
}
