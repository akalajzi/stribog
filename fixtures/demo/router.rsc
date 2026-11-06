# 2026-11-02 03:30:04 by RouterOS 7.20.4
# software id = DEMO-0001
#
# model = RB5009UPr+S+
# serial number = HFD0DEMO001
/interface bridge
add admin-mac=00:00:5E:00:53:01 auto-mac=no comment="Home LAN" name=bridge \
    vlan-filtering=yes
/interface ethernet
set [ find default-name=ether1 ] comment="WAN to ONT (Example Fibre)" \
    poe-out=off
set [ find default-name=ether2 ] comment="NAS - hall cupboard"
set [ find default-name=ether3 ] comment="Study desktop"
set [ find default-name=ether4 ] comment="Living room TV (wall plate)"
set [ find default-name=ether5 ] comment="Spare"
set [ find default-name=ether6 ] comment="Future garden AP - PoE off" \
    poe-out=off
set [ find default-name=ether7 ] comment="cAP living room (PoE)"
set [ find default-name=ether8 ] comment="cAP upstairs landing (PoE)"
/interface vlan
add comment="Guest Wi-Fi" interface=bridge name=vlan20-guest vlan-id=20
/interface list
add comment=defconf name=WAN
add comment=defconf name=LAN
/interface wifi channel
add band=2ghz-ax frequency=2412,2437,2462 name=ch-2g width=20mhz
add band=5ghz-ax frequency=5180,5200,5220,5240 name=ch-5g \
    skip-dfs-channels=all width=20/40/80mhz
/interface wifi datapath
add bridge=bridge comment="Home LAN" disabled=no name=dp-home
add bridge=bridge comment="Guest VLAN 20" disabled=no name=dp-guest \
    vlan-id=20
/interface wifi security
add authentication-types=wpa2-psk,wpa3-psk disabled=no encryption=ccmp ft=\
    yes ft-over-ds=yes name=sec-home passphrase="correct horse battery staple"
add authentication-types=wpa2-psk disabled=no encryption=ccmp ft=yes \
    ft-over-ds=yes name=sec-guest passphrase=\
    "welcome to \"Maple Street\""
/interface wifi configuration
add channel=ch-2g country="United Kingdom" datapath=dp-home disabled=no \
    mode=ap name=home-2g security=sec-home ssid=Maple
add channel=ch-5g country="United Kingdom" datapath=dp-home disabled=no \
    mode=ap name=home-5g security=sec-home ssid=Maple
add country="United Kingdom" datapath=dp-guest disabled=no mode=ap name=\
    guest-2g security=sec-guest ssid="Maple Guest"
add country="United Kingdom" datapath=dp-guest disabled=no mode=ap name=\
    guest-5g security=sec-guest ssid="Maple Guest"
/interface wifi
# operated by CAP 00:00:5E:00:53:A0%bridge, traffic processing on CAP
add configuration=home-2g disabled=no name=cap-wifi1 radio-mac=\
    00:00:5E:00:53:A2
# operated by CAP 00:00:5E:00:53:A0%bridge, traffic processing on CAP
add configuration=home-5g disabled=no name=cap-wifi2 radio-mac=\
    00:00:5E:00:53:A3
# operated by CAP 00:00:5E:00:53:B0%bridge, traffic processing on CAP
add configuration=home-2g disabled=no name=cap-wifi3 radio-mac=\
    00:00:5E:00:53:B2
# operated by CAP 00:00:5E:00:53:B0%bridge, traffic processing on CAP
add configuration=home-5g disabled=no name=cap-wifi4 radio-mac=\
    00:00:5E:00:53:B3
# operated by CAP 00:00:5E:00:53:A0%bridge, traffic processing on CAP
add configuration=guest-2g disabled=no mac-address=02:00:5E:00:53:A2 \
    master-interface=cap-wifi1 name=cap-guest1
# operated by CAP 00:00:5E:00:53:A0%bridge, traffic processing on CAP
add configuration=guest-5g disabled=no mac-address=02:00:5E:00:53:A3 \
    master-interface=cap-wifi2 name=cap-guest2
# operated by CAP 00:00:5E:00:53:B0%bridge, traffic processing on CAP
add configuration=guest-2g disabled=no mac-address=02:00:5E:00:53:B2 \
    master-interface=cap-wifi3 name=cap-guest3
# operated by CAP 00:00:5E:00:53:B0%bridge, traffic processing on CAP
add configuration=guest-5g disabled=no mac-address=02:00:5E:00:53:B3 \
    master-interface=cap-wifi4 name=cap-guest4
/ip pool
add name=home-pool ranges=192.168.50.100-192.168.50.199
add name=guest-pool ranges=192.168.60.100-192.168.60.199
/ip dhcp-server
add address-pool=home-pool interface=bridge lease-time=1d name=home-dhcp
add address-pool=guest-pool interface=vlan20-guest lease-time=1h name=\
    guest-dhcp
/interface bridge port
add bridge=bridge comment=defconf interface=ether2
add bridge=bridge comment=defconf interface=ether3
add bridge=bridge comment=defconf interface=ether4
add bridge=bridge comment=defconf interface=ether5
add bridge=bridge comment=defconf interface=ether6
add bridge=bridge comment=defconf interface=ether7
add bridge=bridge comment=defconf interface=ether8
add bridge=bridge comment=defconf interface=sfp-sfpplus1
/ip neighbor discovery-settings
set discover-interface-list=LAN
/interface bridge vlan
add bridge=bridge comment="Guest VLAN to the access points" tagged=\
    bridge,ether7,ether8 vlan-ids=20
/interface list member
add comment=defconf interface=bridge list=LAN
add comment=defconf interface=ether1 list=WAN
add interface=vlan20-guest list=LAN
/interface wifi capsman
set enabled=yes interfaces=bridge package-path="" require-peer-certificate=\
    no upgrade-policy=none
/interface wifi provisioning
add action=create-dynamic-enabled master-configuration=home-2g \
    slave-configurations=guest-2g supported-bands=2ghz-ax
add action=create-dynamic-enabled master-configuration=home-5g \
    slave-configurations=guest-5g supported-bands=5ghz-ax
/ip address
add address=192.168.50.1/24 comment="Home LAN gateway" interface=bridge \
    network=192.168.50.0
add address=192.168.60.1/24 comment="Guest gateway" interface=vlan20-guest \
    network=192.168.60.0
/ip dhcp-client
add comment=defconf interface=ether1 use-peer-dns=no
/ip dhcp-server lease
add address=192.168.50.2 comment="cAP living room" mac-address=\
    00:00:5E:00:53:A0 server=home-dhcp
add address=192.168.50.3 comment="cAP upstairs landing" mac-address=\
    00:00:5E:00:53:B0 server=home-dhcp
add address=192.168.50.10 comment="Family NAS - AdGuard Home" mac-address=\
    00:00:5E:00:53:10 server=home-dhcp
add address=192.168.50.20 comment="Study desktop" mac-address=\
    00:00:5E:00:53:20 server=home-dhcp
add address=192.168.50.25 comment="Workshop Pi - sensors" mac-address=\
    00:00:5E:00:53:25 server=home-dhcp
add address=192.168.50.30 comment="Living room TV" mac-address=\
    00:00:5E:00:53:30 server=home-dhcp
add address=192.168.50.40 comment="Kitchen Shelly plug" mac-address=\
    00:00:5E:00:53:40 server=home-dhcp
add address=192.168.50.41 comment="Hallway thermostat sensor" mac-address=\
    00:00:5E:00:53:41 server=home-dhcp
add address=192.168.50.50 comment="Brother printer \E2\80\93 study" \
    mac-address=00:00:5E:00:53:50 server=home-dhcp
add address=192.168.50.60 comment="Emma iPhone" mac-address=\
    3A:00:5E:00:53:60 server=home-dhcp
/ip dhcp-server network
add address=192.168.50.0/24 comment="Home LAN" dns-server=\
    192.168.50.10,192.168.50.1 gateway=192.168.50.1 ntp-server=192.168.50.1
add address=192.168.60.0/24 comment="Guest Wi-Fi" dns-server=192.168.60.1 \
    gateway=192.168.60.1
/ip dns
set allow-remote-requests=yes servers=1.1.1.1,9.9.9.9
/ip dns static
add address=192.168.50.1 comment=defconf name=router.lan type=A
add address=192.168.50.10 name=nas.maple.home.arpa type=A
/ip firewall filter
add action=accept chain=input comment=\
    "defconf: accept established,related,untracked" connection-state=\
    established,related,untracked
add action=drop chain=input comment="defconf: drop invalid" connection-state=\
    invalid
add action=accept chain=input comment="defconf: accept ICMP" protocol=icmp
add action=accept chain=input comment=\
    "defconf: accept to local loopback (for CAPsMAN)" dst-address=127.0.0.1
add action=accept chain=input comment=\
    "TEMP: game server test from the office VPN" disabled=yes dst-port=\
    27015 in-interface-list=WAN protocol=udp
add action=drop chain=input comment="defconf: drop all not coming from LAN" \
    in-interface-list=!LAN
add action=accept chain=forward comment="defconf: accept in ipsec policy" \
    ipsec-policy=in,ipsec
add action=accept chain=forward comment="defconf: accept out ipsec policy" \
    ipsec-policy=out,ipsec
add action=fasttrack-connection chain=forward comment="defconf: fasttrack" \
    connection-state=established,related hw-offload=yes
add action=accept chain=forward comment=\
    "defconf: accept established,related, untracked" connection-state=\
    established,related,untracked
add action=drop chain=forward comment="defconf: drop invalid" \
    connection-state=invalid
add action=drop chain=forward comment="Guest: no access to the home LAN" \
    in-interface=vlan20-guest out-interface=bridge
add action=drop chain=forward comment=\
    "defconf: drop all from WAN not DSTNATed" connection-nat-state=!dstnat \
    in-interface-list=WAN
/ip firewall nat
add action=masquerade chain=srcnat comment="defconf: masquerade" \
    ipsec-policy=out,none out-interface-list=WAN
add action=dst-nat chain=dstnat comment="NAS photos (HTTPS)" dst-port=5001 \
    in-interface-list=WAN protocol=tcp to-addresses=192.168.50.10 to-ports=\
    5001
/ip service
set ftp disabled=yes
set www address=192.168.50.0/24
set winbox address=192.168.50.0/24
set api disabled=yes
set api-ssl disabled=yes
/system clock
set time-zone-name=Europe/London
/system identity
set name=maple-gw
/system note
set show-at-login=no
/system ntp client
set enabled=yes
/system ntp server
set enabled=yes
/system ntp client servers
add address=time.cloudflare.com
add address=uk.pool.ntp.org
/system scheduler
add interval=1d name=nightly-export on-event=\
    "/export show-sensitive=no file=nightly-export" policy=\
    ftp,read,write,policy,test start-date=2026-01-01 start-time=03:30:00
/tool mac-server
set allowed-interface-list=LAN
/tool mac-server mac-winbox
set allowed-interface-list=LAN
