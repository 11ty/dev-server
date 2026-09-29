import DevServer, { type DevServerOptions } from "@11ty/eleventy-dev-server";

let options: DevServerOptions = {
  port: 8080,
  host: "0.0.0.0",
  caseSensitive: false,
  allowedHosts: ["mysite.test"],
  middleware: [
    (req, res, next) => {
      res.setHeader("X-Test", "yes");
      next();
    },
  ],
  onRequest: {
    "/api/:name": ({ patternGroups }) => ({ body: `Hello ${patternGroups.name}` }),
    "/fetch": async () => new Response("ok"),
  },
  messageOnStart: ({ hosts }) => `Server at ${hosts.join(" or ")}`,
  onClientMessage: ({ type, data }) => console.log(type, data),
};

let server = DevServer.getServer("example", "_site", options);
server.serve(8080);

let port: number = await server.getPort();
await server.ready();
server.setAliases({ "/img": "./src/img" });
server.reload({ files: ["./index.md"], build: { outputs: true, templates: [{ url: "/", inputPath: "./index.md", content: "" }], passthrough: [] } });
server.reloadFiles(["_site/index.html"]);
let hosts: string[] = server.getHosts();
await server.close();

// @ts-expect-error unknown option
new DevServer("example", "_site", { prot: 8080 });
// @ts-expect-error wrong type
new DevServer("example", "_site", { caseSensitive: "no" });

export { port, hosts };
