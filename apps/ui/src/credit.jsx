// "Made by AutomateThis!": the plugin is a free tool from AutomateThis (automatethis.pro). Shown at the bottom of the
// sidebar and under the sign-in pages; a plain link, nothing is loaded from that site.
import { Link, Typography } from '@mui/material';

export const MADE_BY_URL = 'https://automatethis.pro';

export function MadeBy({ sx }) {
  return (
    <Typography variant="caption" component="p" color="text.secondary" sx={{ px: 2, ...sx }} data-testid="made-by">
      Made by{' '}
      <Link href={MADE_BY_URL} target="_blank" rel="noopener" underline="hover" color="inherit" sx={{ fontWeight: 600 }}>
        AutomateThis!
      </Link>
    </Typography>
  );
}
