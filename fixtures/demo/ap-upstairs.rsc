# 2026-11-02 03:32:15 by RouterOS 7.19.6
# software id = DEMO-0003
#
# model = cAPGi-5HaxD2HaxD
# serial number = HFD0DEMO003
/interface bridge
add admin-mac=00:00:5E:00:53:B0 auto-mac=no comment=defconf name=bridgeLocal \
    vlan-filtering=yes
/interface wifi datapath
add bridge=bridgeLocal comment=defconf disabled=no name=capdp
/interface wifi
# managed by CAPsMAN 00:00:5E:00:53:01%bridgeLocal, traffic processing on CAP
# mode: AP, SSID: Maple, channel: 2462/ax
set [ find default-name=wifi1 ] configuration.manager=capsman datapath=capdp \
    disabled=no
# managed by CAPsMAN 00:00:5E:00:53:01%bridgeLocal, traffic processing on CAP
# mode: AP, SSID: Maple, channel: 5220/ax/eeCe
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
set name=cap-upstairs
/system ntp client
set enabled=yes
/system ntp client servers
add address=192.168.50.1
/system package update
set channel=long-term
