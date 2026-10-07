import { normalizeEmail, text } from './util';

export interface HubUser {
  email: string;
  displayName: string;
  role: 'staff' | 'student';
  permissions?: {
    isStaff: boolean;
    isSupervisor: boolean;
    isLead: boolean;
    isCoordinator: boolean;
    isAdmin: boolean;
    canAdmin: boolean;
  };
}

export interface PlacementRef {
  supervisorId?: string;
}

const OWNER_OPTIONS = ['student', 'supervisor', 'lead', 'coordinator'];

export function canCompleteMilestone(
  user: HubUser | null,
  studentEmail: string,
  owner: unknown,
  _templateType: unknown,
  knownPlacement?: PlacementRef | null,
): boolean {
  const milestoneOwner = text(owner).toLowerCase();
  if (!user) return false;
  if (user.role === 'staff' && user.permissions && user.permissions.canAdmin) return true;
  if (milestoneOwner === 'student') return user.role === 'student' && user.email === normalizeEmail(studentEmail);
  if (user.role !== 'staff') return false;
  const placement = knownPlacement || null;
  if (milestoneOwner === 'supervisor') {
    if (!placement) return false;
    if (normalizeEmail(placement.supervisorId) === user.email) return true;
    return !text(placement.supervisorId) && !!(user.permissions && user.permissions.canAdmin);
  }
  const permissionName = ('is' + milestoneOwner.charAt(0).toUpperCase() + milestoneOwner.slice(1)) as
    | 'isLead'
    | 'isCoordinator'
    | 'isSupervisor'
    | 'isStudent';
  return OWNER_OPTIONS.includes(milestoneOwner) && !!(user.permissions && (user.permissions as Record<string, boolean>)[permissionName]);
}

export function normalizeStaffView(user: HubUser, viewAs: unknown): 'supervisor' | 'coordinator' | 'staff' {
  const requested = text(viewAs).toLowerCase();
  if (requested === 'supervisor' && user.permissions?.isSupervisor) return 'supervisor';
  if (requested === 'staff') return 'staff';
  if (user.permissions?.canAdmin) return 'coordinator';
  if (user.permissions?.isSupervisor) return 'supervisor';
  return 'staff';
}
