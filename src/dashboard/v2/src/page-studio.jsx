/* Studio (CORE) — merged parent for Canvas · NeuroLab · Terminal · Neuro Room
 * (v3 §1). Sub-views statically imported so they bundle into this chunk (§3.4);
 * page-neuroroom pulls livekit-client, so the heavy voice dep lives in the
 * studio chunk and only loads when Studio is opened. */
import './page-canvas.jsx';
import './page-neurolab.jsx';
import './page-terminal.jsx';
import './page-neuroroom.jsx';
import './page-interactive.jsx';
import './page-imagegen.jsx';
import './page-videogen.jsx';
import './page-musicgen.jsx';
import './page-gamestudio.jsx';
import './page-editor.jsx';
import './page-photopea.jsx';
import './page-gallery.jsx';
import './page-media.jsx';
import './page-backlot.jsx';

const Studio = () => (
  <SubTabs pageId="studio" tabs={[
    { id: 'canvas',      label: 'Canvas',      render: () => <Canvas/> },
    { id: 'neurolab',    label: 'NeuroLab',    render: () => <NeuroLab/> },
    { id: 'terminal',    label: 'Terminal',    render: () => <Terminal/> },
    { id: 'neuroroom',   label: 'Neuro Room',  render: () => <NeuroRoom/> },
    { id: 'interactive', label: 'Interactive', render: () => <Interactive/> },
    { id: 'imagegen',    label: 'Generate',    render: () => <ImageGen/> },
    { id: 'videogen',    label: 'Video',       render: () => <VideoGen/> },
    { id: 'musicgen',    label: 'Music',       render: () => <MusicGen/> },
    { id: 'gamestudio',  label: 'Games',       render: () => <GameStudio/> },
    { id: 'editor',      label: 'Editor',      render: () => <ImageEditor/> },
    { id: 'photopea',    label: 'Photopea',    render: () => <Photopea/> },
    { id: 'gallery',     label: 'Gallery',     render: () => <Gallery/> },
    { id: 'media',       label: 'Media',       render: () => <Media/> },
    { id: 'backlot',     label: 'Backlot',     render: () => <Backlot/> },
  ]}/>
);

window.Studio = Studio;
