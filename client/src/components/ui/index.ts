/**
 * Atlas Bound — UI primitives barrel export.
 *
 * Import primitives from `@/components/ui` to keep import statements
 * clean across the app:
 *
 * ```tsx
 * import { Button, Card, Modal, Section, StatBlock, HPBar, Badge, Divider, showToast } from '@/components/ui';
 * ```
 *
 * Each primitive is documented in its own file. See the UI unification
 * plan at `.claude/plans/delegated-chasing-wozniak.md` for the full
 * design system rationale.
 */

export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { IconButton } from './IconButton';
export type { IconButtonProps, IconButtonSize, IconButtonVariant } from './IconButton';

export { TextInput, NumberInput, Textarea, Select, FieldGroup } from './TextInput';
export type {
  TextInputProps, NumberInputProps, TextareaProps, SelectProps, InputSize,
} from './TextInput';

export { Section } from './Section';
export type { SectionProps } from './Section';

export { Card } from './Card';
export type { CardProps, CardVariant, CardAccent } from './Card';

export { Modal } from './Modal';
export type { ModalProps, ModalSize } from './Modal';

export { Divider } from './Divider';
export type { DividerProps } from './Divider';

export { Badge } from './Badge';
export type { BadgeProps, BadgeVariant, BadgeSize } from './Badge';

export { HPBar } from './HPBar';
export type { HPBarProps, HPBarSize } from './HPBar';

export { StatBlock } from './StatBlock';
export type {
  StatBlockProps, StatBlockSize, AbilityScores, AbilityName,
} from './StatBlock';

export { ToastHost, showToast, dismissToast, useToast } from './Toast';
export type { ToastOptions, ToastVariant } from './Toast';

export { Tabs } from './Tabs';
export type { TabsProps, TabItem, TabsVariant } from './Tabs';

// Pre-existing InfoTooltip — keep it in the barrel so future code
// can use the same single import source for all UI primitives.
export { InfoTooltip } from './InfoTooltip';
