/* Mission Control · Discipline sub-tab placeholder.
 * The full discipline board is being rebuilt; this stub keeps the merged
 * TasksHub chunk bundling while the feature is finalized.
 */
const BoardDiscipline = () => (
  <div className="nc-panel glow" style={{ padding: 32, textAlign: 'center' }}>
    <Icon name="tasks" size={42} className="neonc" style={{ opacity: 0.6 }} />
    <div className="mono muted" style={{ marginTop: 14, fontSize: 12 }}>// discipline board placeholder</div>
    <div className="mono muted" style={{ marginTop: 4, fontSize: 10 }}>full task-discipline UI is under reconstruction</div>
  </div>
);
window.BoardDiscipline = BoardDiscipline;
