# 2026-11-02 03:31:40 by RouterOS 7.20.4
# software id = DEMO-0002
#
# model = cAPGi-5HaxD2HaxD
# serial number = HFD0DEMO002
/interface bridge
add admin-mac=00:00:5E:00:53:A0 auto-mac=no comment=defconf name=bridgeLocal \
    vlan-filtering=yes
/interface wifi datapath
add bridge=bridgeLocal comment=defconf disabled=no name=capdp
/interface wifi
# managed by CAPsMAN 00:00:5E:00:53:01%bridgeLocal, traffic processing on CAP
# mode: AP, SSID: Maple, channel: 2412/ax
set [ find default-name=wifi1 ] configuration.manager=capsman datapath=capdp \
    disabled=no
# managed by CAPsMAN 00:00:5E:00:53:01%bridgeLocal, traffic processing on CAP
# mode: AP, SSID: Maple, channel: 5180/ax/Ceee
set [ find default-name=wifi2 ] configuration.manager=capsman datapath=capdp \
    disabled=no
/interface bridge port
add bridge=bridgeLocal comment=defconf interface=ether1
add bridge=bridgeLocal comment=defconf interface=ether2
/interface bridge vlan
add bridge=bridgeLocal tagged=ether1 vlan-ids=20
/interface wifi cap
set discovery-interfaces=bridgeLocal enabled=yes slaves-datapath=capdp
/ip dhcp-client
add comment=defconf interface=bridgeLocal
/ip service
set ftp disabled=yes
set telnet disabled=yes
set api disabled=yes
set api-ssl disabled=yes
/system clock
set time-zone-name=Europe/London
/system identity
set name=cap-living
/system ntp client
set enabled=yes
/system ntp client servers
add address=192.168.50.1
