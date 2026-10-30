// Line icons (Lucide, ISC licence): 1.5px stroke, round caps, 16px in controls and 18px in navigation, colour from
// the text (currentColor), as the design system says. Wrapped so MUI's fontSize="small" keeps working.
import {
  ChevronLeft, ChevronRight, CircleHelp, ExternalLink, FolderOpen, GripVertical, Image, ImagePlus, LayoutDashboard, Lock,
  PencilLine, Settings, ShieldCheck, Table2, Trash2, Undo2, Upload,
} from 'lucide-react';

const SIZES = { small: 16, medium: 18, inherit: '1em', large: 22 };
const wrap = (Icon) => function CmsIcon({ fontSize = 'medium', ...props }) {
  return <Icon size={SIZES[fontSize] ?? 18} strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" {...props} />;
};

export const UploadIcon = wrap(Upload);
export const RenameIcon = wrap(PencilLine);
export const FolderOpenIcon = wrap(FolderOpen);
export const OpenInNewIcon = wrap(ExternalLink);
export const UndoIcon = wrap(Undo2);
export const AddImageIcon = wrap(ImagePlus);
export const MoveLeftIcon = wrap(ChevronLeft);
export const MoveRightIcon = wrap(ChevronRight);
export const DeleteIcon = wrap(Trash2);
export const DragHandleIcon = wrap(GripVertical);
export const AdminIcon = wrap(ShieldCheck);
export const SecurityIcon = wrap(Lock);
export const DashboardIcon = wrap(LayoutDashboard);
export const TableIcon = wrap(Table2);
export const ImageIcon = wrap(Image);
export const FaqIcon = wrap(CircleHelp);
export const SettingsIcon = wrap(Settings);
