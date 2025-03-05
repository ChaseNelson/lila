import { attributesModule, classModule, init } from 'snabbdom';
import { GameCtrl } from '../gameCtrl';
import { DevCtrl } from './devCtrl';
import { DevAssets, type AssetList } from './devAssets';
import { renderDevSide } from './devSideView';
import { BotCtrl } from '../botCtrl';
import { PushCtrl } from './pushCtrl';
import { env, makeEnv } from '../localEnv';
import { renderGameView } from '../gameView';
import { LocalDb } from '../localDb';
import type { RoundController } from 'round';
import type { LocalPlayOpts } from '../types';
import { myUserId, myUsername } from 'common';

const patch = init([classModule, attributesModule]);

interface LocalPlayDevOpts extends LocalPlayOpts {
  assets?: AssetList;
  pgn?: string;
  name?: string;
  canPost: boolean;
}

export async function initModule(opts: LocalPlayDevOpts): Promise<void> {
  if (opts.pgn && opts.name) {
    makeEnv({ bot: new BotCtrl(), assets: new DevAssets() });
    await Promise.all([env.bot.initBots(), env.assets.init()]);
    await env.repo.importPgn(opts.name, new Blob([opts.pgn], { type: 'application/x-chess-pgn' }), 16, true);
    return;
  }
  if (window.screen.width < 1260) return;

  makeEnv({
    redraw,
    bot: new BotCtrl(),
    push: new PushCtrl(),
    assets: new DevAssets(opts.assets),
    dev: new DevCtrl(),
    db: new LocalDb(),
    game: new GameCtrl(opts),
    user: myUserId(),
    username: myUsername(),
    canPost: opts.canPost,
  });

  await Promise.all([env.db.init(), env.bot.init(opts.bots), env.dev.init(), env.assets.init()]);
  env.game.load(
    hashGameId()
      ? await env.db.get(hashGameId())
      : JSON.parse(localStorage.getItem('local.dev.setup') ?? '{}'),
  );

  const el = document.querySelector('main') ?? document.createElement('main');
  document.getElementById('main-wrap')?.appendChild(el);

  let vnode = patch(el, renderGameView(renderDevSide()));

  env.round = await site.asset.loadEsm<RoundController>('round', { init: env.game.proxy.roundOpts });
  redraw();

  function redraw() {
    vnode = patch(vnode, renderGameView(renderDevSide()));
    env.round.redraw();
  }
}

function hashGameId() {
  const params = location.hash
    .slice(1)
    .split('&')
    .map(p => decodeURIComponent(p).split('='))
    .filter(p => p.length === 2);
  return params.find(p => p[0] === 'id')?.[1];
}
