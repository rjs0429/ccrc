// `ccrc update` checks the SSH signature of a release tag with `git verify-tag`, which runs OpenSSH's ssh-keygen.
// It comes with the SSH client package, whose name differs between distributions.

const PACKAGES: [manager: string, command: string][] = [
  ["apt-get", "sudo apt-get install openssh-client"],
  ["dnf", "sudo dnf install openssh-clients"],
  ["pacman", "sudo pacman -S --needed openssh"],
  ["zypper", "sudo zypper install openssh-clients"],
];

// How to install ssh-keygen here, by the first package manager found; a lowercase phrase that ends a sentence.
export function sshKeygenInstall(which: (cmd: string) => string | undefined): string {
  for (const [manager, command] of PACKAGES) if (which(manager)) return `install it with: ${command}`;
  return "install OpenSSH's client with the system's package manager (openssh-client on Debian and Ubuntu, openssh-clients on Fedora, RHEL and openSUSE, openssh on Arch)";
}
