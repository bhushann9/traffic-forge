{pkgs}: {
  deps = [
    pkgs.alsa-lib
    pkgs.systemd
    pkgs.xorg.libxcb
    pkgs.expat
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.dbus
    pkgs.nspr
    pkgs.libxkbcommon
    pkgs.mesa
    pkgs.libdrm
    pkgs.cups
    pkgs.atk
    pkgs.nss
    pkgs.glib
  ];
}
