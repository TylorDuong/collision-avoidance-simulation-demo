// Tab registry. Each tab owns a panel in index.html (`panel` is its id); `create()` returns
// one view per mount point in that panel, in order. A view implements
// { mount, update, resize, unmount }.

import { createScene3dView } from './scene3d/scene3dView.js';
import { createTcasView } from './tcas/tcasView.js';

export const VIEWS = {
  tcas: { label: 'TCAS', panel: 'cockpit', create: () => [createTcasView({ ownId: 'A' }), createTcasView({ ownId: 'B' })] },
  scene3d: { label: '3D', panel: 'scene3d', create: () => [createScene3dView()] },
};
