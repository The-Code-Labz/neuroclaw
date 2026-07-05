/* Studio (CORE) — merged parent for Canvas · NeuroLab · Terminal · Neuro Room
 * (v3 §1). Sub-views statically imported so they bundle into this chunk (§3.4);
 * page-neuroroom pulls livekit-client, so the heavy voice dep lives in the
 * studio chunk and only loads when Studio is opened. */
import './page-canvas.jsx';
import './page-neurolab.jsx';
import './page-terminal.jsx';
import './page-neuroroom.jsx';
import './page-interactive.jsx';

const Studio = () => (
  <SubTabs pageId="studio" tabs={[
    { id: 'canvas',      label: 'Canvas',      render: () => <Canvas/> },
    { id: 'neurolab',    label: 'NeuroLab',    render: () => <NeuroLab/> },
    { id: 'terminal',    label: 'Terminal',    render: () => <Terminal/> },
    { id: 'neuroroom',   label: 'Neuro Room',  render: () => <NeuroRoom/> },
    { id: 'interactive', label: 'Interactive', render: () => <Interactive/> },
  ]}/>
);

window.Studio = Studio;
