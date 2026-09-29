import net from "node:net";

function tryListen(port, host) {
  return new Promise((resolve) => {
    let server = net.createServer();
    server.once("error", (err) => resolve(err.code));
    server.listen({ port, host }, () => server.close(() => resolve()));
  });
}

// macOS allows binding `127.0.0.1:<port>` even when another process listens on every interface at that port,
// so check every interface first. Returns whether the port is taken.
export async function isPortInUse(port, host) {
  // Port 0 picks a free port, and binding every interface already conflicts correctly
  if(!port || host === "0.0.0.0" || host === "::") {
    return false;
  }

  let code = await tryListen(port, "::");
  // Machines without IPv6
  if(code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL") {
    code = await tryListen(port, "0.0.0.0");
  }
  return code === "EADDRINUSE";
}

export function portInUseError(port) {
  let error = new Error(`Port ${port} is in use.`);
  error.code = "EADDRINUSE";
  error.port = Number(port);
  return error;
}
