import { existsSync } from 'node:fs';
import { selectJournalPath, type JournalSelection } from './journal-discovery.js';
import { ingestJournalOnce, type JournalTailResult } from './journal-tail.js';
import type { JournalIngestOptions } from './options.js';

export interface JournalPollResult extends JournalTailResult {
  readonly selection: JournalSelection;
  readonly switched_journal: boolean;
}

export class ConsoleJournalPoller {
  private activeJournalPath: string | undefined;

  public constructor(private readonly options: JournalIngestOptions) {}

  public pollOnce(): JournalPollResult {
    if (this.options.journal !== undefined) {
      const selection = selectJournalPath(this.options);
      this.activeJournalPath = selection.journal_path;
      return {
        ...ingestJournalOnce({
          journal_path: selection.journal_path,
          checkpoint_dir: this.options.checkpoint_dir,
        }),
        selection,
        switched_journal: false,
      };
    }

    if (this.activeJournalPath !== undefined && existsSync(this.activeJournalPath)) {
      const currentResult = ingestJournalOnce({
        journal_path: this.activeJournalPath,
        checkpoint_dir: this.options.checkpoint_dir,
      });
      const latestSelection = selectJournalPath(this.options);
      if (latestSelection.journal_path === this.activeJournalPath) {
        return {
          ...currentResult,
          selection: latestSelection,
          switched_journal: false,
        };
      }

      this.activeJournalPath = latestSelection.journal_path;
      const nextResult = ingestJournalOnce({
        journal_path: latestSelection.journal_path,
        checkpoint_dir: this.options.checkpoint_dir,
      });
      return {
        events: [...currentResult.events, ...nextResult.events],
        malformed_lines: [...currentResult.malformed_lines, ...nextResult.malformed_lines],
        checkpoint: nextResult.checkpoint,
        selection: latestSelection,
        switched_journal: true,
      };
    }

    const selection = selectJournalPath(this.options);
    this.activeJournalPath = selection.journal_path;
    return {
      ...ingestJournalOnce({
        journal_path: selection.journal_path,
        checkpoint_dir: this.options.checkpoint_dir,
      }),
      selection,
      switched_journal: false,
    };
  }
}
