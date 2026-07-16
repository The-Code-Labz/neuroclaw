/* Studio v4 — merged parent for Canvas · NeuroLab · Terminal · Neuro Room.
 * Imports the v4 Canvas first so it wins the global `window.Canvas` slot,
 * then reuses all other studio tabs from dashboard/v2.
 */

import './page-canvas.jsx';
import '../../v2/src/page-neurolab.jsx';
import '../../v2/src/page-terminal.jsx';
import '../../v2/src/page-neuroroom.jsx';
import '../../v2/src/page-interactive.jsx';
import '../../v2/src/page-imagegen.jsx';
import '../../v2/src/page-editor.jsx';
import '../../v2/src/page-gallery.jsx';
import '../../v2/src/page-media.jsx';

const Studio = () => (
  <SubTabs pageId="studio" tabs={[
    { id: 'canvas',      label: 'Canvas',      render: () => <Canvas/> },
    { id: 'neurolab',    label: 'NeuroLab',    render: () => <NeuroLab/> },
    { id: 'terminal',    label: 'Terminal',    render: () => <Terminal/> },
    { id: 'neuroroom',   label: 'Neuro Room',  render: () => <NeuroRoom/> },
    { id: 'interactive', label: 'Interactive', render: () => <Interactive/> },
    { id: 'imagegen',    label: 'Generate',    render: () => <ImageGen/> },
    { id: 'editor',      label: 'Editor',      render: () => <ImageEditor/> },
    { id: 'gallery',     label: 'Gallery',     render: () => <Gallery/> },
    { id: 'media',       label: 'Media',       render: () => <Media/> },
  ]}/>
);

window.Studio = Studio;
