/* Mission Control · Discipline sub-tab placeholder.
 * The full discipline board is being rebuilt; this stub keeps the merged
 * TasksHub chunk bundling while the feature is finalized.
 */
const BoardDiscipline = () => (
  <div style={{ border: '1px solid var(--line-soft)', borderRadius: 'var(--radius-panel, 6px)', padding: '56px 32px', textAlign: 'center' }}>
    <Icon name="tasks" size={36} className="neonc" style={{ opacity: 0.5 }} />
    <div className="mono muted" style={{ marginTop: 16, fontSize: 12 }}>// discipline board placeholder</div>
    <div className="mono muted" style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>full task-discipline UI is under reconstruction</div>
  </div>
);
window.BoardDiscipline = BoardDiscipline;
