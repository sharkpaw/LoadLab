import { Play } from 'lucide-react';
import { t } from '../lib/i18n';
import { useConfirm } from './ui';

/** Asks before every test start: a start sends real load to the target site. */
export function useConfirmStart() {
  const confirm = useConfirm();
  return (name: string, details?: string) =>
    confirm({
      title: t('Start this test?'),
      confirmLabel: t('Start'),
      icon: <Play className="size-4" />,
      body: (
        <div className="space-y-3">
          <div className="rounded-md border border-line bg-surface-2 px-3 py-2">
            <div className="font-medium">{name}</div>
            {details && <div className="mt-0.5 text-xs text-ink-3">{details}</div>}
          </div>
          <p className="text-sm text-ink-2">{t('LoadLab will send real traffic to this site. Only test sites you own, and make sure now is a good time.')}</p>
        </div>
      ),
    });
}
