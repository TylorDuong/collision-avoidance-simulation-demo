// View registry. Add a view by implementing { mount, update, resize, unmount } and listing it here.

import { createScene3dView } from './scene3d/scene3dView.js';
import { createTcasView } from './tcas/tcasView.js';

export const VIEWS = {
  scene3d: { label: '3D', create: createScene3dView },
  tcas: { label: 'TCAS', create: createTcasView },
};
