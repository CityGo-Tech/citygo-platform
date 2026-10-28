export class CustomerReadDenied extends Error {}

// The backend is authoritative. Revalidation also avoids displaying a private
// response under a different account after another tab changes the session.
export async function readCustomerAsCurrentAdmin<T>({
  viewerId,
  ticket,
  dashboard,
  read,
}: {
  viewerId: string;
  ticket: { check: () => void };
  dashboard: () => Promise<{
    user: { id: string; role?: string; mustChangePassword?: boolean };
  }>;
  read: () => Promise<T>;
}) {
  ticket.check();
  const current = await dashboard();
  ticket.check();
  if (
    current.user.id !== viewerId ||
    current.user.role !== "super_admin" ||
    current.user.mustChangePassword
  )
    throw new CustomerReadDenied();
  const value = await read();
  ticket.check();
  return value;
}
