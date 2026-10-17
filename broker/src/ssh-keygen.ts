// `ccrc update` checks the SSH signature of a release tag with `git verify-tag`, which runs OpenSSH's ssh-keygen.
// It comes with the SSH client package, whose name differs between distributions.

const PACKAGES: [manager: string, command: string][] = [
  ["apt-get", "sudo apt-get install openssh-client"],
  ["dnf", "sudo dnf install openssh-clients"],
  ["pacman", "sudo pacman -S --needed openssh"],
  ["zypper", "sudo zypper install openssh-clients"],
];

export const NEEDED_SSH_KEYGEN = "ssh-keygen from OpenSSH 8.2 or newer";

// git cannot check an SSH signature without ssh-keygen, nor with one that has no -Y find-principals (OpenSSH before
// 8.2; RHEL 8 ships 8.0).
export type SshKeygenProblem = "missing" | "old";

// From what `git verify-tag` printed when it failed.
export function gitSshKeygenProblem(stderr: string): SshKeygenProblem | undefined {
  if (/cannot run ssh-keygen\b/.test(stderr)) return "missing";
  if (/find-principals\/verify is needed/.test(stderr)) return "old";
  return undefined;
}

// Asks ssh-keygen what git asks it before checking a signature, about files that hold none. git takes usage text in
// the answer for an ssh-keygen without -Y find-principals; a newer one fails on the empty signature instead.
export async function sshKeygenTooOld(run: (cmd: string, args: string[]) => Promise<{ stderr: string }>): Promise<boolean> {
  const r = await run("ssh-keygen", ["-Y", "find-principals", "-f", "/dev/null", "-s", "/dev/null"]);
  return r.stderr.includes("usage:");
}

// How to install ssh-keygen here, by the first package manager found; a lowercase phrase that ends a sentence.
export function sshKeygenInstall(which: (cmd: string) => string | undefined): string {
  for (const [manager, command] of PACKAGES) if (which(manager)) return `install it with: ${command}`;
  return "install OpenSSH's client with the system's package manager (openssh-client on Debian and Ubuntu, openssh-clients on Fedora, RHEL and openSUSE, openssh on Arch)";
}

// What to do about the problem; a lowercase phrase that ends a sentence.
export function sshKeygenFix(problem: SshKeygenProblem, which: (cmd: string) => string | undefined): string {
  return problem === "missing" ? sshKeygenInstall(which) : "install OpenSSH 8.2 or newer and make its ssh-keygen the first on PATH (RHEL 8 and its rebuilds ship 8.0)";
}
