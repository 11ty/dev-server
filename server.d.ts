import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer } from "node:http2";
import type { FSWatcher } from "chokidar";
import type WebSocket from "ws";

export interface MessageOnStartArgs {
  hosts: string[];
  localhostUrl: string;
  startupTime: number;
  version: string;
  options: EleventyDevServerOptions;
}

export interface MessageOnCloseArgs {
  version: string;
  options: EleventyDevServerOptions;
}

export interface OnRequestArgs {
  url: URL;
  pattern: URLPattern;
  patternGroups: Record<string, string>;
}

export interface OnRequestResult {
  status?: number;
  headers?: Headers | Record<string, string>;
  body?: string | Buffer;
}

export type OnRequestHandler = (
  args: OnRequestArgs,
) =>
  | string
  | Response
  | OnRequestResult
  | Promise<string | Response | OnRequestResult | void>
  | void;

export interface Logger {
  info(...args: any[]): void;
  log(...args: any[]): void;
  error(...args: any[]): void;
}

export interface HttpsOptions {
  key?: string;
  cert?: string;
}

export interface EleventyDevServerOptions {
  port?: number;

  reloadPort?: number | false;

  liveReload?: boolean;

  showAllHosts?: boolean;

  injectedScriptsFolder?: string;

  portReassignmentRetryCount?: number;

  https?: HttpsOptions;

  domDiff?: boolean;

  showVersion?: boolean;

  encoding?: BufferEncoding;

  pathPrefix?: string;

  watch?: string[];

  chokidarOptions?: Record<string, any>;

  chokidar?: FSWatcher;

  aliases?: Record<string, string>;

  indexFileName?: string;

  useCache?: boolean;

  headers?: Record<string, string>;

  middleware?: Array<
    (req: IncomingMessage, res: ServerResponse, next?: () => void) => any
  >;

  onRequest?: Record<string, OnRequestHandler>;

  messageOnStart?: (args: MessageOnStartArgs) => string | false | void;

  messageOnClose?: (args: MessageOnCloseArgs) => string | false | void;

  logger?: Logger;

  /**
   * deprecated aliases
   */
  folder?: string;

  domdiff?: boolean;

  enabled?: boolean;
}

export interface ReloadTemplate {
  url: string;
  inputPath: string;
  content: string;
}

export interface ReloadEvent {
  subtype?: string;

  files?: string[];

  build?: {
    templates?: ReloadTemplate[];
  };
}

export default class EleventyDevServer {
  constructor(name: string, dir: string, options?: EleventyDevServerOptions);

  static getServer(
    name: string,
    dir: string,
    options?: EleventyDevServerOptions,
  ): EleventyDevServer;

  options: EleventyDevServerOptions;

  dir: string;

  fileCache: Record<string, string>;

  updateServer?: WebSocket.Server;

  logger: Logger;

  watcher?: FSWatcher;

  server: HttpServer | Http2SecureServer;

  normalizeOptions(options?: EleventyDevServerOptions): void;

  cleanupPathPrefix(pathPrefix?: string): string;

  setAliases(aliases: Record<string, string>): void;

  getWatcher(): FSWatcher | undefined;

  watchFiles(targets: string[]): void;

  serve(port: number): void;

  ready(): Promise<void>;

  close(): Promise<void>;

  reload(event?: ReloadEvent): void;

  reloadFiles(files: string[], useDomDiffingForHtml?: boolean): void;

  sendError(args: { error: Error }): void;

  sendUpdateNotification(obj: any): void;

  getHosts(): string[];

  getServerUrl(host: string, pathname?: string): string;

  getServerUrlRaw(host: string, pathname?: string, isRaw?: boolean): string;

  getServerPath(pathname: string): string;

  getPort(): Promise<number>;

  getUrlsFromFilePath(path: string): string[];

  getBuildTemplatesFromFilePath(path: string): ReloadTemplate[];
}
