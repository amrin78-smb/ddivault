-- PowerDNS fixture. Deliberately a MIRROR of zones/lab.example.db: same records,
-- same values, only the zone name differs. tests/dnsProviders.test.js asserts the
-- two providers spell every record identically after swapping the zone name, which
-- only means something if the fixtures are genuinely equivalent.
INSERT INTO domains (name, type) VALUES ('pdns.example', 'NATIVE');
INSERT INTO records (domain_id, name, type, content, ttl, prio) VALUES
 (1,'pdns.example','SOA','ns1.pdns.example admin.pdns.example 2026111801 7200 3600 1209600 3600',3600,0),
 (1,'pdns.example','NS','ns1.pdns.example',3600,0),
 (1,'ns1.pdns.example','A','10.0.0.1',3600,0),
 (1,'web.pdns.example','A','10.0.0.10',3600,0),
 (1,'web.pdns.example','A','10.0.0.12',3600,0),
 (1,'db.pdns.example','A','10.0.0.11',3600,0),
 (1,'app.pdns.example','CNAME','web.pdns.example',3600,0),
 (1,'pdns.example','MX','mail.pdns.example',3600,10),
 (1,'mail.pdns.example','A','10.0.0.20',3600,0),
 (1,'_sip._tcp.pdns.example','SRV','20 5060 sip.pdns.example',3600,10),
 (1,'pdns.example','TXT','"v=spf1 -all"',3600,0);
INSERT INTO domains (name, type) VALUES ('1.10.in-addr.arpa', 'NATIVE');
INSERT INTO records (domain_id, name, type, content, ttl, prio) VALUES
 (2,'1.10.in-addr.arpa','SOA','ns1.pdns.example admin.pdns.example 2026111801 7200 3600 1209600 3600',3600,0),
 (2,'1.10.in-addr.arpa','NS','ns1.pdns.example',3600,0),
 (2,'10.0.1.10.in-addr.arpa','PTR','web.pdns.example',3600,0);
