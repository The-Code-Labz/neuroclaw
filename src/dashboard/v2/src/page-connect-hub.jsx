/* Connect (SYSTEM) — merged parent for Providers · MCP · Skills · Channels ·
 * Composio (v3 §1). Named -hub to avoid clashing with the PWA page-connect.jsx
 * (ConnectScreen). Sub-views statically imported so they bundle into this
 * chunk (§3.4). The Composio sub-tab renders the existing Connections view. */
import './page-providers.jsx';
import './page-mcp.jsx';
import './page-skills.jsx';
import './page-channels.jsx';
import './page-connections.jsx';

const ConnectHub = () => (
  <SubTabs pageId="connect" tabs={[
    { id: 'providers', label: 'Providers', render: () => <Providers/> },
    { id: 'mcp',       label: 'MCP',       render: () => <MCP/> },
    { id: 'skills',    label: 'Skills',    render: () => <Skills/> },
    { id: 'channels',  label: 'Channels',  render: () => <Channels/> },
    { id: 'composio',  label: 'Composio',  render: () => <Connections/> },
  ]}/>
);

window.ConnectHub = ConnectHub;
