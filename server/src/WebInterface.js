/**
 * Server
 *
 * runs a http server at default port 5080.
 * uses express to serve and manage pages.
 * ws takes care of websocket data streams
 * which are packed into bytearrays using
 * msgpack by ygoe.
 *
 * https://github.com/expressjs/express
 * https://github.com/ygoe/msgpack.js
 * https://www.npmjs.com/package/ws
 * https://github.com/websockets/ws/blob/HEAD/doc/ws.md
 *
 *
 */
import BvhBody from './bvh/BvhBody.js';
import BvhConstants from './bvh/BvhConstants.js';
import BvhParser from './bvh/BvhParser.js';
import { log } from './Log.js';
import express from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import msgpack from '@ygoe/msgpack';
import WebSocket from 'ws';

export default class WebInterface {
  #settings;
  #sources;

  constructor(options = {}) {
    this.#settings = options.settings || {};
    this.#sources = options.sources;

    const _self = this;
    const app = express();
    const __dirname = path.resolve();

    /** TODO check if this.#settings is valid and not empty. */
    const publicDir = path.join(__dirname, './', this.#settings.get.server.web.path.public);
    const appDir = path.join(__dirname, './', this.#settings.get.server.web.path.app);

    var corsOptions = {
      origin: '*',
    };

    app.use(express.json());
    app.use(express.static(publicDir));
    app.use(cors(corsOptions));

    const server = http.createServer(app);

    /**
     * In order to develop custom web-apps, a folder outside the
     * project folder is reserved (if it doesn't exist, create
     * folder external/app next to the repo folder axis-streamer).
     *
     * axis-streamer/
     * external/
     * ├── app/
     * ├── storage/
     *
     * All external web-apps can be stored, hosted and accessed there
     * by requesting http://localhost:5080/app
     *
     */

    app.use('/app', express.static(appDir));

    this.#ws = new WebSocket.Server({ server });

    this.#ws.on('connection', (ws) => {
      // listen for changes to sources list
      this.#sources.asObservable().subscribe((sources) => {
        const bytes = msgpack.serialize({ address: 'sources', args: sources });
        ws.send(bytes);
      });

      const bytes = msgpack.serialize({ address: 'settings', args: _self.#settings.get });
      ws.send(bytes);

      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      const addr = ws._socket.remoteAddress.replace('::ffff:', '');
      const port = ws._socket.remotePort;
      log.info(`⇌ WebInterface: new connection from ${addr}:${port} (${_self.#ws.clients.size})`);

      ws.on('message', (m) => {
        try {
          const result = msgpack.deserialize(m);
          log.debug(`WebInterface: received from ${addr}:${port} ${JSON.stringify(result)}`);

          switch (result.address) {
            case 'source/activation':
              const source = this.#sources.value.find((src) => src.id === result.args.sourceId);
              if (source) source.active = result.args.state;
              break;
          }
        } catch (err) {
          log.warn(`WebInterface: not able to deserialize message from ${addr}:${port}`);
        }
      });

      ws.on('close', (m) => {
        log.info(
          `⚡WebInterface: connection closed by ${addr}:${port} (${_self.#ws.clients.size})`,
        );
        return ws.terminate;
      });
    });

    this.#ws.on('close', () => {});

    server.listen(options.port || 5080, () => {
      const port = server.address().port;
      log.info(`✓ WebInterface: starting web-server at http://0.0.0.0:${port}`);
    });
  }

  publish(settings = {}) {
    const range = settings.get.server.web.range || BvhConstants.defaultSkeleton;
    const packet = { address: 'pn', args: [] };
    /**  schema { address: string, args: [{ id: Number, data: [{ joints: [x, y, z], ... }]}]}  */

    /** collect all data from sources */
    this.#sources.value.forEach((body) => {
      const id = body.id;
      // console.log(JSON.stringify(body.flat['RightUpLeg']));
      // console.log(JSON.stringify(body.flat['RightUpLeg'].positionAbsolute));
      const data = WebInterface.getJsonFor(body, range);
      packet.args.push({ id, data });
    });

    /** pack data */
    const bytes = msgpack.serialize(packet);

    /** send data to all connected clients */
    this.#ws.clients.forEach((client) => {
      client.send(bytes);
    });
  }

  static getJsonFor(theBody, theRange) {
    const data = {};
    theRange.forEach((el) => {
      const joint = theBody.flat[el];
      if (joint !== undefined) {
        data[el] = joint.positionAbsolute.xyz;
        if (joint.hasEndPoint === true) {
          data[el + 'End'] = joint.endPositionAbsolute.xyz;
        }
      }
    });
    return data;
  }

  #ws;
}
